package scheduler

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/robfig/cron/v3"

	"taskfire/worker/queue"
)

// CronJob defines a scheduled job.
type CronJob struct {
	ID       string                 `json:"id"`
	Schedule string                 `json:"schedule"` // cron expression
	JobType  string                 `json:"job_type"`
	Payload  map[string]interface{} `json:"payload"`
}

// Scheduler manages cron-based job scheduling.
type Scheduler struct {
	cron  *cron.Cron
	queue queue.Queue
}

func NewScheduler(q queue.Queue) *Scheduler {
	return &Scheduler{
		cron:  cron.New(cron.WithSeconds()),
		queue: q,
	}
}

func (s *Scheduler) Start(ctx context.Context) {
	// Register default cron jobs
	s.AddJob(&CronJob{
		ID:       "metrics-flush",
		Schedule: "0 * * * * *", // every minute
		JobType:  "noop",
		Payload:  map[string]interface{}{"task": "metrics-flush"},
	})

	s.cron.Start()
	log.Println("Scheduler started")

	<-ctx.Done()
	s.cron.Stop()
	log.Println("Scheduler stopped")
}

func (s *Scheduler) AddJob(cj *CronJob) error {
	_, err := s.cron.AddFunc(cj.Schedule, func() {
		job := &queue.Job{
			ID:        uuid.NewString(),
			Type:      cj.JobType,
			Payload:   cj.Payload,
			MaxRetries: 3,
			CreatedAt: time.Now(),
		}
		if err := s.queue.Enqueue(context.Background(), "default", job); err != nil {
			log.Printf("Scheduler failed to enqueue job %s: %v", cj.ID, err)
		} else {
			log.Printf("Scheduler enqueued %s job %s", cj.JobType, job.ID)
		}
	})
	return err
}

// LoadFromRedis loads cron jobs stored in Redis key "taskfire:crons".
func (s *Scheduler) LoadFromRedis(ctx context.Context, client interface {
	LRange(ctx context.Context, key string, start, stop int64) interface{}
}) {
	// Placeholder: in production, deserialize CronJob list from Redis
	_ = json.Marshal // suppress unused import
}
