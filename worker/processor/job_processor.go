package processor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"

	"taskfire/worker/metrics"
	"taskfire/worker/queue"
	"taskfire/worker/retry"
)

// HandlerFunc is the signature all job type handlers must implement.
// It receives the full job record so handlers can inspect metadata
// (priority, retry count, etc.) in addition to the payload.
type HandlerFunc func(ctx context.Context, job *queue.Job) error

// Store persists job state changes to the underlying database.
// A PostgresStore implementation is provided in this package; callers may
// substitute any alternative (e.g. a mock for tests).
type Store interface {
	UpdateJobStatus(ctx context.Context, job *queue.Job) error
}

// JobEvent is published to Redis pub/sub on every job state transition so
// the API layer can forward updates to dashboard WebSocket clients in real time.
type JobEvent struct {
	Type      string          `json:"type"`       // started | completed | failed | retry | dead
	JobID     string          `json:"job_id"`
	JobType   string          `json:"job_type"`
	Status    queue.JobStatus `json:"status"`
	Timestamp time.Time       `json:"timestamp"`
	WorkerID  int             `json:"worker_id,omitempty"`
	Error     string          `json:"error,omitempty"`
}

// EventChannel is the Redis pub/sub channel all job lifecycle events are broadcast on.
const EventChannel = "taskfire:events"

// DependencyChecker gates job execution on its upstream dependencies. The dag
// package provides the production implementation; inject a stub for tests.
type DependencyChecker interface {
	// CanRun returns (true, nil) when all declared dependencies of job have
	// completed, (false, nil) when blocked, or (false, err) on query errors.
	CanRun(ctx context.Context, job *queue.Job) (bool, error)
}

// JobProcessor dispatches jobs to registered handlers, manages state transitions
// in PostgreSQL, emits lifecycle events to Redis pub/sub, and drives the retry
// and dead-letter-queue logic via the retry.Manager.
type JobProcessor struct {
	mu       sync.RWMutex
	handlers map[string]HandlerFunc

	depChecker DependencyChecker // nil == no dep checking
	retrier    *retry.Manager
	store      Store
	queue      queue.Queue
	logger     zerolog.Logger
}

// New creates a JobProcessor wired to the given queue (for Ack/Nack/Enqueue
// and pub/sub Publish), store (for DB state updates), and logger.
func New(q queue.Queue, store Store, logger zerolog.Logger) *JobProcessor {
	jp := &JobProcessor{
		handlers: make(map[string]HandlerFunc),
		retrier:  retry.NewManager(),
		store:    store,
		queue:    q,
		logger:   logger,
	}

	// Built-in handlers. Register additional types via jp.Register before
	// handing the processor to the pool.
	jp.Register("email", emailHandler)
	jp.Register("webhook", webhookHandler)
	jp.Register("noop", noopHandler)

	return jp
}

// SetDependencyChecker wires a DependencyChecker into the processor. Call
// before starting the worker pool. Safe for single-threaded setup only.
func (jp *JobProcessor) SetDependencyChecker(dc DependencyChecker) {
	jp.depChecker = dc
}

// Register adds or replaces the handler for jobType. It is safe to call
// Register after the processor is running; the handler map is RW-locked.
func (jp *JobProcessor) Register(jobType string, h HandlerFunc) {
	jp.mu.Lock()
	defer jp.mu.Unlock()
	jp.handlers[jobType] = h
}

// RegisterRetryConfig sets custom backoff parameters for a specific job type.
func (jp *JobProcessor) RegisterRetryConfig(jobType string, cfg retry.Config) {
	jp.retrier.Register(jobType, cfg)
}

// Process executes the handler for job, manages the full state lifecycle
// (pending → active → completed | failed | dead), updates the database after
// every transition, and emits Redis pub/sub events for real-time monitoring.
//
// Process always calls either Ack, Nack+Enqueue (retry), or Nack+MoveToDLQ on
// the queue before returning, so callers do not need to perform cleanup.
func (jp *JobProcessor) Process(ctx context.Context, job *queue.Job) error {
	log := jp.logger.With().
		Str("job_id", job.ID).
		Str("job_type", job.Type).
		Int("retry_count", job.RetryCount).
		Logger()

	// ── Dependency gate ─────────────────────────────────────────────────────
	if jp.depChecker != nil {
		ok, err := jp.depChecker.CanRun(ctx, job)
		if err != nil {
			log.Error().Err(err).Msg("dependency check failed; requeueing")
			if nErr := jp.queue.Nack(ctx, job); nErr != nil {
				log.Error().Err(nErr).Msg("nack failed after dep check error")
			}
			return err
		}
		if !ok {
			// Reschedule for 5 seconds from now so it does not spin-loop.
			if nErr := jp.queue.Nack(ctx, job); nErr != nil {
				log.Error().Err(nErr).Msg("nack failed for blocked dep job")
			}
			retryAt := time.Now().Add(5 * time.Second)
			if dErr := jp.queue.EnqueueDelayed(ctx, job, retryAt); dErr != nil {
				log.Error().Err(dErr).Msg("failed to enqueue delayed blocked job")
			}
			log.Debug().Msg("job blocked on dependencies; rescheduled in 5s")
			return nil
		}
	}

	// ── Transition to active ────────────────────────────────────────────────
	now := time.Now()
	job.Status = queue.StatusActive
	job.StartedAt = &now

	if err := jp.store.UpdateJobStatus(ctx, job); err != nil {
		log.Error().Err(err).Msg("failed to mark job active in database")
		// Non-fatal: continue processing even if the DB write fails.
	}

	jp.publishEvent(ctx, JobEvent{
		Type:      "started",
		JobID:     job.ID,
		JobType:   job.Type,
		Status:    queue.StatusActive,
		Timestamp: now,
	})

	metrics.ActiveWorkers.Inc()
	defer metrics.ActiveWorkers.Dec()

	// ── Locate handler ──────────────────────────────────────────────────────
	jp.mu.RLock()
	h, ok := jp.handlers[job.Type]
	jp.mu.RUnlock()

	if !ok {
		cause := fmt.Errorf("no handler registered for job type %q", job.Type)
		metrics.JobsFailed.WithLabelValues(job.Type, "unknown_type").Inc()
		return jp.handleFailure(ctx, job, cause, log)
	}

	// ── Execute handler with panic recovery ─────────────────────────────────
	start := time.Now()
	err := safeRun(ctx, job, h)
	elapsed := time.Since(start)

	metrics.JobDuration.WithLabelValues(job.Type).Observe(elapsed.Seconds())

	if err != nil {
		metrics.JobsFailed.WithLabelValues(job.Type, failureReason(err)).Inc()
		return jp.handleFailure(ctx, job, err, log)
	}

	// ── Success path ────────────────────────────────────────────────────────
	completed := time.Now()
	job.Status = queue.StatusCompleted
	job.CompletedAt = &completed

	metrics.JobsProcessed.WithLabelValues(job.Type, metrics.PriorityLabel(int(job.Priority))).Inc()

	if err := jp.store.UpdateJobStatus(ctx, job); err != nil {
		log.Error().Err(err).Msg("failed to mark job completed in database")
	}

	jp.publishEvent(ctx, JobEvent{
		Type:      "completed",
		JobID:     job.ID,
		JobType:   job.Type,
		Status:    queue.StatusCompleted,
		Timestamp: completed,
	})

	if err := jp.queue.Ack(ctx, job); err != nil {
		log.Error().Err(err).Msg("ack failed after successful processing")
		return err
	}

	log.Info().
		Dur("duration", elapsed).
		Msg("job completed")

	return nil
}

// handleFailure decides whether to retry the job or send it to the DLQ.
// It always calls Nack to release the processing lock before returning.
func (jp *JobProcessor) handleFailure(ctx context.Context, job *queue.Job, cause error, log zerolog.Logger) error {
	job.RetryCount++
	job.ErrorMessage = cause.Error()

	// Release the processing lock regardless of what happens next.
	if nackErr := jp.queue.Nack(ctx, job); nackErr != nil {
		log.Error().Err(nackErr).Msg("nack failed during error handling")
	}

	metrics.RetryAttempts.WithLabelValues(job.Type).Inc()

	// Decide retry vs DLQ.
	waitErr := jp.retrier.Wait(ctx, job.ID, job.Type, job.RetryCount, cause, log)
	if waitErr != nil {
		// Either retries exhausted or context cancelled — go to DLQ.
		return jp.sendToDLQ(ctx, job, waitErr, log)
	}

	// ── Retry: re-enqueue the job ───────────────────────────────────────────
	job.Status = queue.StatusPending
	job.StartedAt = nil

	if err := jp.store.UpdateJobStatus(ctx, job); err != nil {
		log.Error().Err(err).Msg("failed to reset job status for retry")
	}

	jp.publishEvent(ctx, JobEvent{
		Type:      "retry",
		JobID:     job.ID,
		JobType:   job.Type,
		Status:    queue.StatusPending,
		Timestamp: time.Now(),
		Error:     cause.Error(),
	})

	if err := jp.queue.Enqueue(ctx, job); err != nil {
		log.Error().Err(err).Msg("failed to re-enqueue job for retry; routing to DLQ")
		return jp.sendToDLQ(ctx, job, err, log)
	}

	log.Warn().
		Int("retry_count", job.RetryCount).
		Str("cause", cause.Error()).
		Msg("job re-enqueued for retry")

	return cause
}

// sendToDLQ marks the job as permanently dead in the database and moves it to
// the dead-letter queue in Redis.
func (jp *JobProcessor) sendToDLQ(ctx context.Context, job *queue.Job, reason error, log zerolog.Logger) error {
	now := time.Now()
	job.Status = queue.StatusDead
	job.FailedAt = &now

	if err := jp.store.UpdateJobStatus(ctx, job); err != nil {
		log.Error().Err(err).Msg("failed to mark job dead in database")
	}

	jp.publishEvent(ctx, JobEvent{
		Type:      "dead",
		JobID:     job.ID,
		JobType:   job.Type,
		Status:    queue.StatusDead,
		Timestamp: now,
		Error:     job.ErrorMessage,
	})

	if err := jp.queue.MoveToDLQ(ctx, job, reason); err != nil {
		log.Error().Err(err).Msg("failed to move job to dead-letter queue")
		return err
	}

	return reason
}

// publishEvent serialises a JobEvent and broadcasts it to EventChannel.
// Publish failures are logged but do not interrupt job processing.
func (jp *JobProcessor) publishEvent(ctx context.Context, ev JobEvent) {
	data, err := json.Marshal(ev)
	if err != nil {
		jp.logger.Error().Err(err).Msg("failed to marshal job event")
		return
	}
	if err := jp.queue.Publish(ctx, EventChannel, data); err != nil {
		jp.logger.Error().Err(err).Str("channel", EventChannel).Msg("failed to publish job event")
	}
}

// failureReason maps an error to a concise Prometheus label value.
func failureReason(err error) string {
	if err == nil {
		return "handler_error"
	}
	if errors.Is(err, context.Canceled) {
		return "context_cancelled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "deadline_exceeded"
	}
	msg := err.Error()
	if len(msg) >= 14 && msg[:14] == "handler panic:" {
		return "panic"
	}
	if msg == "no handler registered" {
		return "unknown_type"
	}
	return "handler_error"
}

// safeRun calls the handler inside a deferred recover so a panicking handler
// cannot crash the worker goroutine.
func safeRun(ctx context.Context, job *queue.Job, h HandlerFunc) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("handler panic: %v", r)
		}
	}()
	return h(ctx, job)
}

// ── Built-in handlers ──────────────────────────────────────────────────────

func emailHandler(ctx context.Context, job *queue.Job) error {
	// In production this would call an SMTP/SES client using job.Payload fields.
	to, _ := job.Payload["to"].(string)
	subject, _ := job.Payload["subject"].(string)
	zerolog.Ctx(ctx).Debug().
		Str("job_id", job.ID).
		Str("to", to).
		Str("subject", subject).
		Msg("sending email")
	time.Sleep(40 * time.Millisecond) // simulate I/O
	return nil
}

func webhookHandler(ctx context.Context, job *queue.Job) error {
	url, _ := job.Payload["url"].(string)
	zerolog.Ctx(ctx).Debug().
		Str("job_id", job.ID).
		Str("url", url).
		Msg("firing webhook")
	time.Sleep(80 * time.Millisecond) // simulate HTTP call
	return nil
}

func noopHandler(_ context.Context, _ *queue.Job) error {
	return nil
}

// ── PostgresStore ──────────────────────────────────────────────────────────

// PostgresStore implements Store using a pgxpool connection pool. The UPDATE
// statement writes all mutable job fields in one round-trip so callers never
// need to build partial queries.
type PostgresStore struct {
	pool *pgxpool.Pool
}

// NewPostgresStore creates a PostgresStore from an existing pgxpool.Pool.
func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore {
	return &PostgresStore{pool: pool}
}

// UpdateJobStatus persists the current mutable state of job to the jobs table.
func (s *PostgresStore) UpdateJobStatus(ctx context.Context, job *queue.Job) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE jobs
		SET
			status       = $2,
			retry_count  = $3,
			started_at   = $4,
			completed_at = $5,
			failed_at    = $6,
			error        = $7
		WHERE id = $1`,
		job.ID,
		string(job.Status),
		job.RetryCount,
		job.StartedAt,
		job.CompletedAt,
		job.FailedAt,
		nullableString(job.ErrorMessage),
	)
	if err != nil {
		return fmt.Errorf("update job %s: %w", job.ID, err)
	}
	return nil
}

func nullableString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
