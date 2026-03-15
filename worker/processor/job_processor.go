package processor

import (
	"context"
	"fmt"
	"log"
	"time"

	"taskfire/worker/metrics"
	"taskfire/worker/queue"
	"taskfire/worker/retry"
)

// HandlerFunc processes a job payload and returns an error on failure.
type HandlerFunc func(ctx context.Context, payload map[string]interface{}) error

// JobProcessor dispatches jobs to registered handlers.
type JobProcessor struct {
	handlers map[string]HandlerFunc
	backoff  *retry.ExponentialBackoff
}

func NewJobProcessor() *JobProcessor {
	jp := &JobProcessor{
		handlers: make(map[string]HandlerFunc),
		backoff:  retry.NewExponentialBackoff(500*time.Millisecond, 30*time.Second, 2.0),
	}
	// Register built-in handlers
	jp.Register("email", emailHandler)
	jp.Register("webhook", webhookHandler)
	jp.Register("noop", noopHandler)
	return jp
}

func (jp *JobProcessor) Register(jobType string, handler HandlerFunc) {
	jp.handlers[jobType] = handler
}

func (jp *JobProcessor) Process(ctx context.Context, job *queue.Job) error {
	handler, ok := jp.handlers[job.Type]
	if !ok {
		return fmt.Errorf("unknown job type: %s", job.Type)
	}

	start := time.Now()
	metrics.JobsProcessed.WithLabelValues(job.Type).Inc()
	metrics.ActiveWorkers.Inc()
	defer metrics.ActiveWorkers.Dec()

	delay := jp.backoff.Delay(job.RetryCount)
	if delay > 0 && job.RetryCount > 0 {
		log.Printf("Job %s retry %d, waiting %v", job.ID, job.RetryCount, delay)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}

	err := handler(ctx, job.Payload)
	duration := time.Since(start).Seconds()
	metrics.JobDuration.WithLabelValues(job.Type).Observe(duration)

	if err != nil {
		metrics.JobsFailed.WithLabelValues(job.Type).Inc()
		return err
	}
	return nil
}

// Built-in handlers

func emailHandler(ctx context.Context, payload map[string]interface{}) error {
	log.Printf("Sending email to %v", payload["to"])
	time.Sleep(50 * time.Millisecond) // simulate work
	return nil
}

func webhookHandler(ctx context.Context, payload map[string]interface{}) error {
	log.Printf("Calling webhook %v", payload["url"])
	time.Sleep(100 * time.Millisecond)
	return nil
}

func noopHandler(_ context.Context, _ map[string]interface{}) error {
	return nil
}
