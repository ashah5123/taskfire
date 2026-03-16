package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

// JobStatus represents the lifecycle state of a job.
type JobStatus string

const (
	StatusPending   JobStatus = "pending"
	StatusActive    JobStatus = "active"
	StatusCompleted JobStatus = "completed"
	StatusFailed    JobStatus = "failed"
	StatusDead      JobStatus = "dead"
)

// Priority determines which queue lane a job is placed in.
// Higher numeric values are processed before lower ones.
type Priority int

const (
	PriorityLow    Priority = 100
	PriorityMedium Priority = 200
	PriorityHigh   Priority = 300
)

// Job is the canonical record passed through the queue, processor, and store.
type Job struct {
	ID           string                 `json:"id"`
	Type         string                 `json:"type"`
	Payload      map[string]interface{} `json:"payload"`
	Priority     Priority               `json:"priority"`
	Status       JobStatus              `json:"status"`
	MaxRetries   int                    `json:"max_retries"`
	RetryCount   int                    `json:"retry_count"`
	CreatedAt    time.Time              `json:"created_at"`
	ScheduledAt  *time.Time             `json:"scheduled_at,omitempty"`
	StartedAt    *time.Time             `json:"started_at,omitempty"`
	CompletedAt  *time.Time             `json:"completed_at,omitempty"`
	FailedAt     *time.Time             `json:"failed_at,omitempty"`
	ErrorMessage string                 `json:"error_message,omitempty"`
	Dependencies []string               `json:"dependencies,omitempty"`
}

// Queue defines the operations a job broker must expose.
type Queue interface {
	// Enqueue places a job into the priority lane appropriate for its Priority.
	// Within a lane jobs are ordered FIFO by enqueue time.
	Enqueue(ctx context.Context, job *Job) error

	// EnqueueDelayed places a job into the delayed sorted set scored by
	// scheduledAt unix seconds. DrainDelayed moves it to a priority lane
	// when the scheduled time arrives.
	EnqueueDelayed(ctx context.Context, job *Job, scheduledAt time.Time) error

	// DrainDelayed atomically moves up to maxBatch ready delayed jobs (score ≤ now)
	// into their priority lanes. Returns the number of jobs moved.
	DrainDelayed(ctx context.Context, now time.Time, maxBatch int) (int, error)

	// Dequeue atomically claims the next available job across all priority lanes
	// (high → medium → low). Returns (nil, nil) when all queues are empty.
	Dequeue(ctx context.Context) (*Job, error)

	// Ack records successful completion: removes the job from the processing
	// set, deletes its lock, and appends it to the completed list.
	Ack(ctx context.Context, job *Job) error

	// Nack removes a job from the processing set and releases its lock without
	// re-enqueuing. The caller is responsible for retrying or discarding.
	Nack(ctx context.Context, job *Job) error

	// MoveToDLQ moves a permanently failed job to the dead-letter sorted set,
	// scored by failure time for ordered inspection and replay.
	MoveToDLQ(ctx context.Context, job *Job, reason error) error

	// QueueDepth returns the total number of jobs waiting across all priority lanes.
	QueueDepth(ctx context.Context) (int64, error)

	// QueueDepthByLane returns the pending job count per priority lane.
	QueueDepthByLane(ctx context.Context) (high, medium, low int64, err error)

	// DLQSize returns the number of entries in the dead-letter sorted set.
	DLQSize(ctx context.Context) (int64, error)

	// Publish sends a serialised message to a Redis pub/sub channel.
	Publish(ctx context.Context, channel string, payload []byte) error

	// Close releases the underlying connection.
	Close() error
}

// Redis key constants.
const (
	keyQueueHigh   = "taskfire:queue:high"
	keyQueueMedium = "taskfire:queue:medium"
	keyQueueLow    = "taskfire:queue:low"
	keyProcessing  = "taskfire:processing"
	keyLockPrefix  = "taskfire:lock:"
	keyDLQ         = "taskfire:dlq"
	keyDone        = "taskfire:done"
	keyDelayed     = "taskfire:delayed"
	lockTTLSecs    = 300  // job lock TTL in seconds; covers max expected handler duration
	doneListCap    = 9999 // maximum entries kept in the completed list
)

// drainDelayedScript atomically moves up to ARGV[2] ready delayed jobs
// (score ≤ ARGV[1]) from the delayed sorted set into their priority lanes.
//
// KEYS[1] = delayed sorted set
// KEYS[2] = high-priority sorted set
// KEYS[3] = medium-priority sorted set
// KEYS[4] = low-priority sorted set
// ARGV[1] = current unix seconds (cutoff score)
// ARGV[2] = max number of jobs to move
const drainDelayedScript = `
local items = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
if #items == 0 then return 0 end

local moved = 0
local now_ms = tonumber(redis.call('TIME')[1]) * 1000 + math.floor(tonumber(redis.call('TIME')[2]) / 1000)

for _, data in ipairs(items) do
    local ok, job = pcall(cjson.decode, data)
    if ok and type(job) == 'table' then
        local lane
        local prio = tonumber(job.priority) or 0
        if prio >= 300 then
            lane = KEYS[2]
        elseif prio >= 200 then
            lane = KEYS[3]
        else
            lane = KEYS[4]
        end
        redis.call('ZREM', KEYS[1], data)
        redis.call('ZADD', lane, now_ms + moved, data)
        moved = moved + 1
    end
end
return moved
`

// claimScript atomically pops the highest-priority available job across the
// three priority lanes and acquires a per-job distributed lock to guarantee
// exactly-once delivery even when multiple workers poll simultaneously.
//
// KEYS[1] = high-priority sorted set
// KEYS[2] = medium-priority sorted set
// KEYS[3] = low-priority sorted set
// KEYS[4] = processing hash (job_id → job_json)
// ARGV[1] = lock key prefix
// ARGV[2] = lock TTL in seconds
const claimScript = `
local function try_claim(qkey, proc_key, lock_pfx, ttl)
    local res = redis.call('ZPOPMIN', qkey, 1)
    if #res == 0 then return nil end

    local data  = res[1]
    local score = res[2]

    local ok, job = pcall(cjson.decode, data)
    if not ok or type(job) ~= 'table' or not job.id then
        -- Malformed payload: discard rather than re-queue to avoid poison loops.
        redis.call('LPUSH', 'taskfire:malformed', data)
        return nil
    end

    local lk       = lock_pfx .. job.id
    local acquired = redis.call('SET', lk, '1', 'NX', 'EX', tonumber(ttl))
    if not acquired then
        -- Another worker already holds the lock; restore the job and back off.
        redis.call('ZADD', qkey, tonumber(score), data)
        return nil
    end

    redis.call('HSET', proc_key, job.id, data)
    return data
end

local r
r = try_claim(KEYS[1], KEYS[4], ARGV[1], ARGV[2])
if r then return r end
r = try_claim(KEYS[2], KEYS[4], ARGV[1], ARGV[2])
if r then return r end
r = try_claim(KEYS[3], KEYS[4], ARGV[1], ARGV[2])
if r then return r end
return nil
`

// RedisQueue implements Queue using Redis sorted sets as priority lanes and
// Redis pub/sub for event broadcasting.
type RedisQueue struct {
	client      *redis.Client
	script      *redis.Script
	drainScript *redis.Script
	logger      zerolog.Logger
}

// NewRedisQueue connects to Redis, verifies connectivity, and returns a queue
// ready for use. The Lua claim script is pre-loaded on first Dequeue call via
// EVALSHA, falling back to EVAL on NOSCRIPT errors automatically.
func NewRedisQueue(redisURL string, logger zerolog.Logger) (*RedisQueue, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("parse redis URL: %w", err)
	}

	client := redis.NewClient(opts)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("redis ping: %w", err)
	}

	logger.Info().Str("addr", opts.Addr).Msg("redis connected")

	return &RedisQueue{
		client:      client,
		script:      redis.NewScript(claimScript),
		drainScript: redis.NewScript(drainDelayedScript),
		logger:      logger,
	}, nil
}

// Enqueue adds a job to the priority lane determined by job.Priority.
// Within a lane, jobs are ordered by enqueue time (FIFO) using the unix-nano
// timestamp as the sorted-set score.
func (q *RedisQueue) Enqueue(ctx context.Context, job *Job) error {
	data, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("marshal job %s: %w", job.ID, err)
	}

	key := q.laneKey(job.Priority)
	// Unix milliseconds as score: monotonically increasing (FIFO within lane)
	// and well within float64's 53-bit mantissa precision (2^53 ≈ 9×10^15 >> 1.7×10^12 ms).
	score := float64(time.Now().UnixMilli())

	if err := q.client.ZAdd(ctx, key, redis.Z{Score: score, Member: string(data)}).Err(); err != nil {
		return fmt.Errorf("zadd %s: %w", key, err)
	}

	q.logger.Debug().
		Str("job_id", job.ID).
		Str("job_type", job.Type).
		Str("lane", key).
		Int("priority", int(job.Priority)).
		Msg("job enqueued")

	return nil
}

// Dequeue atomically claims the next available job using the Lua claim script.
// It checks lanes in priority order (high → medium → low) and returns
// (nil, nil) when all queues are empty.
func (q *RedisQueue) Dequeue(ctx context.Context) (*Job, error) {
	val, err := q.script.Run(ctx, q.client,
		[]string{keyQueueHigh, keyQueueMedium, keyQueueLow, keyProcessing},
		keyLockPrefix, lockTTLSecs,
	).Result()

	if err != nil {
		// redis.Nil is returned when the Lua script returns nil (all lanes empty).
		if errors.Is(err, redis.Nil) {
			return nil, nil
		}
		return nil, fmt.Errorf("claim script: %w", err)
	}

	if val == nil {
		return nil, nil
	}

	raw, ok := val.(string)
	if !ok || raw == "" {
		return nil, nil
	}

	var job Job
	if err := json.Unmarshal([]byte(raw), &job); err != nil {
		return nil, fmt.Errorf("unmarshal claimed job: %w", err)
	}

	q.logger.Debug().
		Str("job_id", job.ID).
		Str("job_type", job.Type).
		Msg("job claimed")

	return &job, nil
}

// Ack records successful job completion. It atomically removes the processing
// entry, deletes the distributed lock, prepends to the completed list, and
// trims the list to doneListCap entries.
func (q *RedisQueue) Ack(ctx context.Context, job *Job) error {
	data, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("marshal job %s for ack: %w", job.ID, err)
	}

	pipe := q.client.Pipeline()
	pipe.HDel(ctx, keyProcessing, job.ID)
	pipe.Del(ctx, keyLockPrefix+job.ID)
	pipe.LPush(ctx, keyDone, string(data))
	pipe.LTrim(ctx, keyDone, 0, doneListCap)

	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("ack pipeline for job %s: %w", job.ID, err)
	}

	q.logger.Debug().Str("job_id", job.ID).Msg("job acked")
	return nil
}

// Nack removes a job from in-flight tracking and releases its lock. It does
// not re-enqueue; the caller decides whether to retry (via Enqueue) or move
// to the DLQ (via MoveToDLQ).
func (q *RedisQueue) Nack(ctx context.Context, job *Job) error {
	pipe := q.client.Pipeline()
	pipe.HDel(ctx, keyProcessing, job.ID)
	pipe.Del(ctx, keyLockPrefix+job.ID)

	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("nack pipeline for job %s: %w", job.ID, err)
	}

	q.logger.Debug().Str("job_id", job.ID).Msg("job nacked")
	return nil
}

// MoveToDLQ atomically removes the job from in-flight tracking and inserts it
// into the dead-letter sorted set scored by failure unix-nano timestamp.
// This ordering lets operators replay or inspect DLQ entries chronologically.
func (q *RedisQueue) MoveToDLQ(ctx context.Context, job *Job, reason error) error {
	now := time.Now()
	job.Status = StatusDead
	job.FailedAt = &now

	// Preserve an existing error message set by the handler or processor;
	// only fall back to the DLQ reason (e.g. ErrRetriesExhausted) when the
	// job has no prior error context.
	if reason != nil && job.ErrorMessage == "" {
		job.ErrorMessage = reason.Error()
	}

	data, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("marshal job %s for dlq: %w", job.ID, err)
	}

	pipe := q.client.Pipeline()
	pipe.HDel(ctx, keyProcessing, job.ID)
	pipe.Del(ctx, keyLockPrefix+job.ID)
	pipe.ZAdd(ctx, keyDLQ, redis.Z{
		Score:  float64(now.UnixNano()),
		Member: string(data),
	})

	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("dlq pipeline for job %s: %w", job.ID, err)
	}

	q.logger.Warn().
		Str("job_id", job.ID).
		Str("job_type", job.Type).
		Str("reason", job.ErrorMessage).
		Msg("job moved to dead-letter queue")

	return nil
}

// QueueDepth returns the total number of jobs currently waiting across all
// three priority lanes. It does not include jobs that are actively processing.
func (q *RedisQueue) QueueDepth(ctx context.Context) (int64, error) {
	pipe := q.client.Pipeline()
	high := pipe.ZCard(ctx, keyQueueHigh)
	med := pipe.ZCard(ctx, keyQueueMedium)
	low := pipe.ZCard(ctx, keyQueueLow)

	if _, err := pipe.Exec(ctx); err != nil {
		return 0, fmt.Errorf("queue depth pipeline: %w", err)
	}

	return high.Val() + med.Val() + low.Val(), nil
}

// Publish serialises payload and sends it to the given Redis pub/sub channel.
func (q *RedisQueue) Publish(ctx context.Context, channel string, payload []byte) error {
	if err := q.client.Publish(ctx, channel, payload).Err(); err != nil {
		return fmt.Errorf("publish to %s: %w", channel, err)
	}
	return nil
}

// Close shuts down the underlying Redis client.
func (q *RedisQueue) Close() error {
	return q.client.Close()
}

// EnqueueDelayed places a job into the delayed sorted set scored by scheduledAt
// unix seconds. The job will be moved into the appropriate priority lane by
// DrainDelayed once its scheduled time arrives.
func (q *RedisQueue) EnqueueDelayed(ctx context.Context, job *Job, scheduledAt time.Time) error {
	job.ScheduledAt = &scheduledAt
	job.Status = StatusPending

	data, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("marshal delayed job %s: %w", job.ID, err)
	}

	score := float64(scheduledAt.Unix())
	if err := q.client.ZAdd(ctx, keyDelayed, redis.Z{Score: score, Member: string(data)}).Err(); err != nil {
		return fmt.Errorf("zadd delayed %s: %w", job.ID, err)
	}

	q.logger.Debug().
		Str("job_id", job.ID).
		Str("job_type", job.Type).
		Time("scheduled_at", scheduledAt).
		Msg("job enqueued as delayed")

	return nil
}

// DrainDelayed atomically moves up to maxBatch ready delayed jobs (score ≤ now)
// into their respective priority lanes. Returns the number of jobs promoted.
func (q *RedisQueue) DrainDelayed(ctx context.Context, now time.Time, maxBatch int) (int, error) {
	val, err := q.drainScript.Run(ctx, q.client,
		[]string{keyDelayed, keyQueueHigh, keyQueueMedium, keyQueueLow},
		now.Unix(), maxBatch,
	).Int()

	if err != nil && !errors.Is(err, redis.Nil) {
		return 0, fmt.Errorf("drain delayed script: %w", err)
	}

	return val, nil
}

// QueueDepthByLane returns the pending job count for each individual priority
// lane without aggregating them.
func (q *RedisQueue) QueueDepthByLane(ctx context.Context) (high, medium, low int64, err error) {
	pipe := q.client.Pipeline()
	highCmd := pipe.ZCard(ctx, keyQueueHigh)
	medCmd := pipe.ZCard(ctx, keyQueueMedium)
	lowCmd := pipe.ZCard(ctx, keyQueueLow)

	if _, err = pipe.Exec(ctx); err != nil {
		return 0, 0, 0, fmt.Errorf("queue depth by lane pipeline: %w", err)
	}

	return highCmd.Val(), medCmd.Val(), lowCmd.Val(), nil
}

// DLQSize returns the number of entries currently in the dead-letter sorted set.
func (q *RedisQueue) DLQSize(ctx context.Context) (int64, error) {
	n, err := q.client.ZCard(ctx, keyDLQ).Result()
	if err != nil {
		return 0, fmt.Errorf("dlq zcard: %w", err)
	}
	return n, nil
}

// laneKey maps a Priority value to its sorted-set key.
func (q *RedisQueue) laneKey(p Priority) string {
	switch {
	case p >= PriorityHigh:
		return keyQueueHigh
	case p >= PriorityMedium:
		return keyQueueMedium
	default:
		return keyQueueLow
	}
}
