package scheduler

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/robfig/cron/v3"
	"github.com/rs/zerolog"

	"taskfire/worker/queue"
)

// CronJob defines a scheduled job template that the Scheduler enqueues
// automatically on its cron expression.
type CronJob struct {
	ID       string                 `json:"id"`
	Schedule string                 `json:"schedule"` // standard cron or six-field (with seconds)
	JobType  string                 `json:"job_type"`
	Priority queue.Priority         `json:"priority"`
	Payload  map[string]interface{} `json:"payload"`
}

// Scheduler enqueues cron-triggered jobs into the task queue and promotes
// delayed jobs to their priority lanes every second.
type Scheduler struct {
	cron   *cron.Cron
	queue  queue.Queue
	logger zerolog.Logger
}

// NewScheduler creates a Scheduler that supports second-granularity cron
// expressions (six fields: second minute hour dom month dow).
func NewScheduler(q queue.Queue, logger zerolog.Logger) *Scheduler {
	return &Scheduler{
		cron:   cron.New(cron.WithSeconds()),
		queue:  q,
		logger: logger,
	}
}

// Start registers built-in cron jobs, launches the delayed-job poller, then
// runs until ctx is cancelled.
func (s *Scheduler) Start(ctx context.Context) {
	_ = s.AddJob(&CronJob{
		ID:       "heartbeat",
		Schedule: "0 * * * * *", // every minute at :00
		JobType:  "noop",
		Priority: queue.PriorityLow,
		Payload:  map[string]interface{}{"task": "heartbeat"},
	})

	s.cron.Start()
	s.logger.Info().Msg("scheduler started")

	// Drain delayed jobs on a one-second tick in a separate goroutine so the
	// cron engine's own goroutines are not blocked.
	go s.runDelayedPoller(ctx)

	<-ctx.Done()

	cronCtx := s.cron.Stop()
	// Wait for any in-progress cron callbacks to finish.
	<-cronCtx.Done()
	s.logger.Info().Msg("scheduler stopped")
}

// AddJob registers a CronJob with the underlying cron engine. It may be called
// before or after Start.
func (s *Scheduler) AddJob(cj *CronJob) error {
	_, err := s.cron.AddFunc(cj.Schedule, func() {
		job := &queue.Job{
			ID:         uuid.NewString(),
			Type:       cj.JobType,
			Payload:    cj.Payload,
			Priority:   cj.Priority,
			Status:     queue.StatusPending,
			MaxRetries: 3,
			CreatedAt:  time.Now(),
		}
		if err := s.queue.Enqueue(context.Background(), job); err != nil {
			s.logger.Error().
				Err(err).
				Str("cron_job_id", cj.ID).
				Str("job_type", cj.JobType).
				Msg("scheduler: enqueue failed")
			return
		}
		s.logger.Info().
			Str("job_id", job.ID).
			Str("job_type", job.Type).
			Str("cron_id", cj.ID).
			Msg("scheduler: job enqueued")
	})
	if err != nil {
		return err
	}
	return nil
}

// ScheduleDelayed enqueues a job for execution at scheduledAt rather than
// immediately. It delegates to queue.EnqueueDelayed.
func (s *Scheduler) ScheduleDelayed(ctx context.Context, job *queue.Job, scheduledAt time.Time) error {
	return s.queue.EnqueueDelayed(ctx, job, scheduledAt)
}

// runDelayedPoller ticks every second and promotes ready delayed jobs into
// their priority lanes. It exits when ctx is cancelled.
func (s *Scheduler) runDelayedPoller(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case t := <-ticker.C:
			n, err := s.queue.DrainDelayed(ctx, t, 100)
			if err != nil {
				if ctx.Err() == nil {
					s.logger.Error().Err(err).Msg("scheduler: drain delayed failed")
				}
				continue
			}
			if n > 0 {
				s.logger.Debug().Int("promoted", n).Msg("scheduler: delayed jobs promoted")
			}
		}
	}
}
