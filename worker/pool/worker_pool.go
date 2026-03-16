package pool

import (
	"context"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"

	"taskfire/worker/metrics"
	"taskfire/worker/processor"
	"taskfire/worker/queue"
)

// Config holds all tunable parameters for the worker pool.
type Config struct {
	// MinWorkers is the floor: the pool never drops below this count.
	MinWorkers int
	// MaxWorkers is the ceiling on dynamically spawned goroutines.
	MaxWorkers int
	// JobChannelBuffer is the capacity of the internal dispatch channel.
	// Setting it to MaxWorkers×2 is a reasonable default.
	JobChannelBuffer int
	// ScaleCheckInterval controls how often the scaler re-evaluates depth.
	ScaleCheckInterval time.Duration
	// IdleTimeout is how long a worker must be idle before it is eligible
	// for scale-down. Workers started to satisfy MinWorkers are exempt.
	IdleTimeout time.Duration
	// HighWatermark: if total queue depth exceeds this, scale up by one worker.
	HighWatermark int64
	// LowWatermark: if total queue depth is at or below this, the scaler may
	// remove the longest-idle worker (subject to MinWorkers floor).
	LowWatermark int64
}

// DefaultConfig returns a Config suitable for a moderately loaded system.
func DefaultConfig() Config {
	return Config{
		MinWorkers:         4,
		MaxWorkers:         32,
		JobChannelBuffer:   64,
		ScaleCheckInterval: 5 * time.Second,
		IdleTimeout:        60 * time.Second,
		HighWatermark:      50,
		LowWatermark:       5,
	}
}

// WorkerStats holds per-worker telemetry. All fields are updated atomically
// so they can be read from the outside (e.g. an admin API) without locking.
type WorkerStats struct {
	ID        int
	StartedAt time.Time

	jobsProcessed atomic.Int64
	errors        atomic.Int64
	lastActiveAt  atomic.Int64  // unix nano; 0 = never active
	currentJobID  atomic.Pointer[string]
}

// JobsProcessed returns the total number of jobs this worker has completed.
func (s *WorkerStats) JobsProcessed() int64 { return s.jobsProcessed.Load() }

// Errors returns the total number of jobs that failed on this worker.
func (s *WorkerStats) Errors() int64 { return s.errors.Load() }

// Uptime returns the duration since the worker was started.
func (s *WorkerStats) Uptime() time.Duration { return time.Since(s.StartedAt) }

// IdleTime returns how long the worker has been idle since its last job.
// If the worker has never processed a job it returns the full uptime.
func (s *WorkerStats) IdleTime() time.Duration {
	last := s.lastActiveAt.Load()
	if last == 0 {
		return time.Since(s.StartedAt)
	}
	return time.Since(time.Unix(0, last))
}

// CurrentJobID returns the ID of the job currently being processed, or an
// empty string if the worker is idle.
func (s *WorkerStats) CurrentJobID() string {
	p := s.currentJobID.Load()
	if p == nil {
		return ""
	}
	return *p
}

// worker represents a single goroutine in the pool.
type worker struct {
	stats  WorkerStats
	cancel context.CancelFunc
	doneCh chan struct{} // closed when the goroutine exits
}

// Pool is a dynamically-scaling goroutine worker pool. A dedicated fetcher
// goroutine polls Redis and pushes jobs onto a buffered dispatch channel;
// worker goroutines consume that channel concurrently. A scaler goroutine
// monitors queue depth and adjusts the active worker count between MinWorkers
// and MaxWorkers.
type Pool struct {
	cfg       Config
	queue     queue.Queue
	proc      *processor.JobProcessor
	logger    zerolog.Logger

	jobCh chan *queue.Job // buffered dispatch channel

	mu      sync.Mutex
	workers map[int]*worker
	nextID  int

	wg sync.WaitGroup // tracks fetcher + scaler + all workers
}

// NewPool creates a Pool. Call Start to begin processing.
func NewPool(cfg Config, q queue.Queue, proc *processor.JobProcessor, logger zerolog.Logger) *Pool {
	if cfg.JobChannelBuffer <= 0 {
		cfg.JobChannelBuffer = cfg.MaxWorkers * 2
	}
	return &Pool{
		cfg:     cfg,
		queue:   q,
		proc:    proc,
		logger:  logger,
		jobCh:   make(chan *queue.Job, cfg.JobChannelBuffer),
		workers: make(map[int]*worker),
	}
}

// Start launches MinWorkers workers, the fetcher, and the scaler. It returns
// immediately; call Wait to block until all goroutines have exited after the
// context is cancelled.
func (p *Pool) Start(ctx context.Context) {
	// Seed the initial worker cohort.
	p.mu.Lock()
	for i := 0; i < p.cfg.MinWorkers; i++ {
		p.spawnWorker(ctx)
	}
	p.mu.Unlock()

	// Fetcher and scaler each hold a WaitGroup slot.
	p.wg.Add(2)
	go p.runFetcher(ctx)
	go p.runScaler(ctx)

	p.logger.Info().
		Int("min_workers", p.cfg.MinWorkers).
		Int("max_workers", p.cfg.MaxWorkers).
		Int("channel_buffer", p.cfg.JobChannelBuffer).
		Msg("worker pool started")
}

// Wait blocks until all goroutines managed by the pool have exited. It should
// be called after the context passed to Start has been cancelled.
func (p *Pool) Wait() {
	p.wg.Wait()
}

// Stats returns live pointers to each active worker's stats struct. Callers
// may read the fields at any time; because all fields are atomic, reads are
// always consistent. The slice itself is a snapshot: workers that exit after
// this call are no longer in it, and new workers are not included.
func (p *Pool) Stats() []*WorkerStats {
	p.mu.Lock()
	out := make([]*WorkerStats, 0, len(p.workers))
	for _, w := range p.workers {
		out = append(out, &w.stats)
	}
	p.mu.Unlock()
	return out
}

// ActiveWorkerCount returns the number of worker goroutines currently tracked
// by the pool (including any that have been signalled to stop but have not yet
// exited).
func (p *Pool) ActiveWorkerCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.workers)
}

// spawnWorker creates a new worker goroutine. Must be called with p.mu held.
func (p *Pool) spawnWorker(ctx context.Context) {
	id := p.nextID
	p.nextID++

	wctx, cancel := context.WithCancel(ctx)
	w := &worker{
		stats:  WorkerStats{ID: id, StartedAt: time.Now()},
		cancel: cancel,
		doneCh: make(chan struct{}),
	}
	p.workers[id] = w

	// Mark new worker as idle immediately so the gauge exists from spawn.
	metrics.WorkerUtilization.WithLabelValues(strconv.Itoa(id)).Set(0.0)

	p.wg.Add(1)
	go p.runWorker(wctx, w)
}

// runFetcher continuously dequeues jobs from Redis and delivers them to the
// buffered dispatch channel. It backs off exponentially when the queue is
// empty, resetting on the next successful dequeue.
func (p *Pool) runFetcher(ctx context.Context) {
	defer p.wg.Done()

	const (
		minBackoff = 10 * time.Millisecond
		maxBackoff = 1 * time.Second
	)
	backoff := minBackoff

	for {
		if ctx.Err() != nil {
			return
		}

		job, err := p.queue.Dequeue(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			p.logger.Error().Err(err).Msg("fetcher: dequeue error")
			p.sleep(ctx, backoff)
			backoff = min(backoff*2, maxBackoff)
			continue
		}

		if job == nil {
			// Queue is empty; back off before polling again.
			p.sleep(ctx, backoff)
			backoff = min(backoff*2, maxBackoff)
			continue
		}

		backoff = minBackoff // reset on successful fetch

		// Deliver to a worker, or abort if context is cancelled while waiting.
		select {
		case <-ctx.Done():
			// The job was claimed from Redis (lock held, removed from priority
			// queue) but we never delivered it to a worker. Re-enqueue it so it
			// is not silently lost, then release the processing lock.
			bgCtx := context.Background()
			job.Status = queue.StatusPending
			if rErr := p.queue.Enqueue(bgCtx, job); rErr != nil {
				p.logger.Error().Err(rErr).Str("job_id", job.ID).
					Msg("fetcher: failed to re-enqueue job during shutdown")
			}
			if nErr := p.queue.Nack(bgCtx, job); nErr != nil {
				p.logger.Error().Err(nErr).Str("job_id", job.ID).
					Msg("fetcher: nack failed during shutdown")
			}
			return
		case p.jobCh <- job:
			p.logger.Debug().Str("job_id", job.ID).Msg("fetcher: dispatched job to channel")
		}
	}
}

// runScaler periodically evaluates queue depth and adjusts the worker count.
func (p *Pool) runScaler(ctx context.Context) {
	defer p.wg.Done()

	ticker := time.NewTicker(p.cfg.ScaleCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			depth, err := p.queue.QueueDepth(ctx)
			if err != nil {
				p.logger.Error().Err(err).Msg("scaler: queue depth check failed")
				continue
			}

			p.mu.Lock()
			current := len(p.workers)

			switch {
			case depth > p.cfg.HighWatermark && current < p.cfg.MaxWorkers:
				p.spawnWorker(ctx)
				p.logger.Info().
					Int64("queue_depth", depth).
					Int("workers_before", current).
					Int("workers_after", len(p.workers)).
					Msg("scaler: scaled up")

			case depth <= p.cfg.LowWatermark && current > p.cfg.MinWorkers:
				if removed := p.evictIdleWorker(); removed != -1 {
					p.logger.Info().
						Int64("queue_depth", depth).
						Int("evicted_worker_id", removed).
						Int("workers_remaining", len(p.workers)-1).
						Msg("scaler: scaled down idle worker")
				}
			}
			p.mu.Unlock()
		}
	}
}

// evictIdleWorker finds the worker with the longest idle time that exceeds
// IdleTimeout, signals it to stop, and returns its ID. Returns -1 if no
// eligible worker is found. Must be called with p.mu held.
func (p *Pool) evictIdleWorker() int {
	var (
		longestIdle time.Duration
		target      *worker
		targetID    = -1
	)

	now := time.Now()
	for id, w := range p.workers {
		lastActive := w.stats.lastActiveAt.Load()
		var idleSince time.Time
		if lastActive == 0 {
			idleSince = w.stats.StartedAt
		} else {
			idleSince = time.Unix(0, lastActive)
		}

		idle := now.Sub(idleSince)
		if idle >= p.cfg.IdleTimeout && idle > longestIdle {
			longestIdle = idle
			target = w
			targetID = id
		}
	}

	if target != nil {
		target.cancel()
	}

	return targetID
}

// runWorker is the main loop for a single worker goroutine. It reads jobs from
// the dispatch channel and delegates to the processor. On context cancellation
// it finishes any in-progress job before exiting.
func (p *Pool) runWorker(ctx context.Context, w *worker) {
	workerLabel := strconv.Itoa(w.stats.ID)

	defer func() {
		// Remove ourselves from the workers map and signal done.
		p.mu.Lock()
		delete(p.workers, w.stats.ID)
		p.mu.Unlock()

		metrics.WorkerUtilization.DeleteLabelValues(workerLabel)

		close(w.doneCh)
		p.wg.Done()

		p.logger.Info().
			Int("worker_id", w.stats.ID).
			Int64("jobs_processed", w.stats.JobsProcessed()).
			Int64("errors", w.stats.Errors()).
			Dur("uptime", w.stats.Uptime()).
			Msg("worker stopped")
	}()

	p.logger.Info().Int("worker_id", w.stats.ID).Msg("worker started")

	for {
		select {
		case <-ctx.Done():
			return

		case job, ok := <-p.jobCh:
			if !ok {
				// Channel was closed (pool shutdown).
				return
			}

			// Track the current job on the stats struct.
			jid := job.ID
			w.stats.currentJobID.Store(&jid)
			metrics.WorkerUtilization.WithLabelValues(workerLabel).Set(1.0)

			if err := p.proc.Process(ctx, job); err != nil {
				w.stats.errors.Add(1)
				p.logger.Error().
					Err(err).
					Str("job_id", job.ID).
					Str("job_type", job.Type).
					Int("worker_id", w.stats.ID).
					Msg("worker: job processing failed")
			} else {
				w.stats.jobsProcessed.Add(1)
			}

			metrics.WorkerUtilization.WithLabelValues(workerLabel).Set(0.0)
			// Mark idle: store current unix-nano as last-active timestamp.
			w.stats.lastActiveAt.Store(time.Now().UnixNano())
			w.stats.currentJobID.Store(nil)
		}
	}
}

// sleep blocks for d, returning early on context cancellation.
func (p *Pool) sleep(ctx context.Context, d time.Duration) {
	if d <= 0 {
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
