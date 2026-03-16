package dag

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"

	"taskfire/worker/queue"
)

// ErrCyclicDependency is returned when the dependency graph contains a cycle.
var ErrCyclicDependency = errors.New("dependency graph contains a cycle")

// ErrDependencyNotMet is returned when one or more upstream jobs have not yet
// completed successfully.
var ErrDependencyNotMet = errors.New("job dependencies not yet satisfied")

// maxGraphDepth limits how many BFS levels are traversed when loading the
// transitive dependency graph. Guards against unbounded queries on deep chains.
const maxGraphDepth = 50

// Engine resolves job dependency graphs, validates them for cycles, and gates
// job execution until all upstream jobs have completed.
type Engine struct {
	pool   *pgxpool.Pool
	logger zerolog.Logger
}

// NewEngine creates a dependency Engine backed by the given Postgres pool.
func NewEngine(pool *pgxpool.Pool, logger zerolog.Logger) *Engine {
	return &Engine{pool: pool, logger: logger}
}

// Validate checks that adding jobID with deps does not create a cycle. It
// loads the full transitive dependency graph from Postgres and runs Kahn's
// topological sort to detect cycles before the job is committed.
func (e *Engine) Validate(ctx context.Context, jobID string, deps []string) error {
	if len(deps) == 0 {
		return nil
	}

	g, err := e.loadGraph(ctx, jobID, deps)
	if err != nil {
		return fmt.Errorf("load dependency graph for job %s: %w", jobID, err)
	}

	if _, err := kahnSort(g); err != nil {
		return err
	}

	return nil
}

// CanRun reports whether all declared dependencies of job have completed
// successfully. It satisfies the processor.DependencyChecker interface.
// Returns (true, nil) when all deps are done, (false, nil) when blocked, and
// (false, err) on query failures.
func (e *Engine) CanRun(ctx context.Context, job *queue.Job) (bool, error) {
	if len(job.Dependencies) == 0 {
		return true, nil
	}

	statuses, err := e.depStatuses(ctx, job.Dependencies)
	if err != nil {
		return false, fmt.Errorf("check dep statuses for job %s: %w", job.ID, err)
	}

	for depID, status := range statuses {
		if status != string(queue.StatusCompleted) {
			e.logger.Debug().
				Str("job_id", job.ID).
				Str("blocked_by", depID).
				Str("dep_status", status).
				Msg("dag: job blocked on dependency")
			return false, nil
		}
	}

	return true, nil
}

// ── graph loading ────────────────────────────────────────────────────────────

// depGraph is an adjacency representation keyed by job ID.
// Each value is the list of direct dependency IDs for that job.
type depGraph map[string][]string

// loadGraph builds the transitive closure of jobID's dependency graph by
// BFS-expanding dependencies from Postgres up to maxGraphDepth levels.
func (e *Engine) loadGraph(ctx context.Context, rootID string, rootDeps []string) (depGraph, error) {
	g := make(depGraph)
	g[rootID] = unique(rootDeps)

	frontier := unique(rootDeps)
	seen := map[string]struct{}{rootID: {}}

	for depth := 0; depth < maxGraphDepth && len(frontier) > 0; depth++ {
		var nextFrontier []string

		rows, err := e.pool.Query(ctx,
			`SELECT id, dependencies FROM jobs WHERE id = ANY($1)`,
			frontier,
		)
		if err != nil {
			return nil, fmt.Errorf("load deps at depth %d: %w", depth, err)
		}

		for rows.Next() {
			var id string
			var deps []string
			if scanErr := rows.Scan(&id, &deps); scanErr != nil {
				rows.Close()
				return nil, fmt.Errorf("scan dep row: %w", scanErr)
			}

			deps = unique(deps)
			g[id] = deps

			for _, d := range deps {
				if _, visited := seen[d]; !visited {
					seen[d] = struct{}{}
					nextFrontier = append(nextFrontier, d)
				}
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("iterate dep rows at depth %d: %w", depth, err)
		}

		frontier = nextFrontier
	}

	if len(frontier) > 0 {
		e.logger.Warn().
			Str("root_job_id", rootID).
			Int("max_depth", maxGraphDepth).
			Msg("dag: graph truncated at max depth; cycle detection may be incomplete")
	}

	return g, nil
}

// ── Kahn's algorithm ─────────────────────────────────────────────────────────

// kahnSort performs Kahn's BFS topological sort on g. In our representation
// g[node] lists the dependencies of node (upstream edges). We re-interpret
// this to build a forward-edge "dependents" map so we can propagate
// in-degree decrements in the standard Kahn's fashion.
//
// A node's "in-degree" is the number of its declared dependencies.
// The algorithm seeds with nodes that have no deps (in-degree == 0) and
// returns ErrCyclicDependency when not all nodes can be reached.
func kahnSort(g depGraph) ([]string, error) {
	inDegree := make(map[string]int, len(g))
	dependents := make(map[string][]string, len(g)) // dep → nodes that depend on it

	// Initialise every known node with in-degree 0.
	for node := range g {
		if _, ok := inDegree[node]; !ok {
			inDegree[node] = 0
		}
	}

	// For each node, in-degree = number of declared dependencies.
	for node, deps := range g {
		for _, dep := range deps {
			if _, ok := inDegree[dep]; !ok {
				inDegree[dep] = 0
			}
			inDegree[node]++
			dependents[dep] = append(dependents[dep], node)
		}
	}

	// Seed queue with dependency-free nodes.
	bfsQueue := make([]string, 0, len(inDegree))
	for node, deg := range inDegree {
		if deg == 0 {
			bfsQueue = append(bfsQueue, node)
		}
	}

	order := make([]string, 0, len(inDegree))
	for len(bfsQueue) > 0 {
		n := bfsQueue[0]
		bfsQueue = bfsQueue[1:]
		order = append(order, n)

		for _, dependent := range dependents[n] {
			inDegree[dependent]--
			if inDegree[dependent] == 0 {
				bfsQueue = append(bfsQueue, dependent)
			}
		}
	}

	if len(order) != len(inDegree) {
		return nil, ErrCyclicDependency
	}

	return order, nil
}

// ── helpers ──────────────────────────────────────────────────────────────────

// depStatuses queries the status of each job in ids and returns a map of
// job_id → status string.
func (e *Engine) depStatuses(ctx context.Context, ids []string) (map[string]string, error) {
	rows, err := e.pool.Query(ctx,
		`SELECT id, status FROM jobs WHERE id = ANY($1)`,
		ids,
	)
	if err != nil {
		return nil, fmt.Errorf("query dep statuses: %w", err)
	}
	defer rows.Close()

	result := make(map[string]string, len(ids))
	for rows.Next() {
		var id, status string
		if err := rows.Scan(&id, &status); err != nil {
			return nil, fmt.Errorf("scan dep status: %w", err)
		}
		result[id] = status
	}
	return result, rows.Err()
}

// unique deduplicates a string slice preserving order.
func unique(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if _, ok := seen[s]; !ok {
			seen[s] = struct{}{}
			out = append(out, s)
		}
	}
	return out
}
