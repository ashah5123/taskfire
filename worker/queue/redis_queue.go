package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Job represents a unit of work.
type Job struct {
	ID          string                 `json:"id"`
	Type        string                 `json:"type"`
	Payload     map[string]interface{} `json:"payload"`
	Priority    int                    `json:"priority"`
	MaxRetries  int                    `json:"max_retries"`
	RetryCount  int                    `json:"retry_count"`
	CreatedAt   time.Time              `json:"created_at"`
	ScheduledAt *time.Time             `json:"scheduled_at,omitempty"`
	Dependencies []string              `json:"dependencies,omitempty"`
}

// Queue defines the interface for job queues.
type Queue interface {
	Enqueue(ctx context.Context, queueName string, job *Job) error
	Dequeue(ctx context.Context, queueName string) (*Job, error)
	Ack(ctx context.Context, job *Job) error
	Nack(ctx context.Context, job *Job, reason error) error
	Close() error
}

type RedisQueue struct {
	client *redis.Client
}

func NewRedisQueue(redisURL string) (*RedisQueue, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("invalid redis URL: %w", err)
	}
	client := redis.NewClient(opts)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping failed: %w", err)
	}
	return &RedisQueue{client: client}, nil
}

func (q *RedisQueue) Enqueue(ctx context.Context, queueName string, job *Job) error {
	data, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("marshal job: %w", err)
	}
	key := fmt.Sprintf("taskfire:queue:%s", queueName)
	score := float64(job.Priority)*-1 // higher priority = lower score for ZPOPMIN
	return q.client.ZAdd(ctx, key, redis.Z{
		Score:  score,
		Member: string(data),
	}).Err()
}

func (q *RedisQueue) Dequeue(ctx context.Context, queueName string) (*Job, error) {
	key := fmt.Sprintf("taskfire:queue:%s", queueName)
	results, err := q.client.BZPopMin(ctx, 2*time.Second, key).Result()
	if err == redis.Nil || len(results) == 0 {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("bzpopmin: %w", err)
	}

	member := results[0].Member.(string)
	var job Job
	if err := json.Unmarshal([]byte(member), &job); err != nil {
		return nil, fmt.Errorf("unmarshal job: %w", err)
	}

	// Move to processing set
	processingKey := fmt.Sprintf("taskfire:processing:%s", queueName)
	q.client.HSet(ctx, processingKey, job.ID, member)

	return &job, nil
}

func (q *RedisQueue) Ack(ctx context.Context, job *Job) error {
	processingKey := fmt.Sprintf("taskfire:processing:default")
	doneKey := fmt.Sprintf("taskfire:done")
	pipe := q.client.Pipeline()
	pipe.HDel(ctx, processingKey, job.ID)
	data, _ := json.Marshal(job)
	pipe.LPush(ctx, doneKey, string(data))
	pipe.LTrim(ctx, doneKey, 0, 9999) // keep last 10k completed jobs
	_, err := pipe.Exec(ctx)
	return err
}

func (q *RedisQueue) Nack(ctx context.Context, job *Job, reason error) error {
	processingKey := "taskfire:processing:default"
	pipe := q.client.Pipeline()
	pipe.HDel(ctx, processingKey, job.ID)
	if job.RetryCount < job.MaxRetries {
		job.RetryCount++
		return q.Enqueue(ctx, "default", job)
	}
	// Move to dead letter queue
	dlqKey := "taskfire:dlq"
	data, _ := json.Marshal(job)
	pipe.LPush(ctx, dlqKey, string(data))
	_, err := pipe.Exec(ctx)
	return err
}

func (q *RedisQueue) Close() error {
	return q.client.Close()
}
