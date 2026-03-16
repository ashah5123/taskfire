package queue

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/rs/zerolog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestQueue(t *testing.T) (*RedisQueue, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	logger := zerolog.Nop()
	q, err := NewRedisQueue("redis://"+mr.Addr(), logger)
	require.NoError(t, err, "NewRedisQueue must succeed against miniredis")
	t.Cleanup(func() { _ = q.Close() })
	return q, mr
}

func makeJob(id string, p Priority) *Job {
	return &Job{
		ID:         id,
		Type:       "noop",
		Payload:    map[string]interface{}{"k": "v"},
		Priority:   p,
		Status:     StatusPending,
		MaxRetries: 3,
		CreatedAt:  time.Now(),
	}
}

// ── Enqueue / QueueDepth ────────────────────────────────────────────────────

func TestEnqueue_IncreasesDepth(t *testing.T) {
	q, _ := newTestQueue(t)
	ctx := context.Background()

	require.NoError(t, q.Enqueue(ctx, makeJob("j1", PriorityMedium)))
	depth, err := q.QueueDepth(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(1), depth)
}

func TestEnqueue_MultipleJobs(t *testing.T) {
	q, _ := newTestQueue(t)
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		require.NoError(t, q.Enqueue(ctx, makeJob("j"+string(rune('a'+i)), PriorityLow)))
	}
	depth, err := q.QueueDepth(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(5), depth)
}

// ── QueueDepthByLane ────────────────────────────────────────────────────────

func TestQueueDepthByLane_OnePerLane(t *testing.T) {
	q, _ := newTestQueue(t)
	ctx := context.Background()

	require.NoError(t, q.Enqueue(ctx, makeJob("hi", PriorityHigh)))
	require.NoError(t, q.Enqueue(ctx, makeJob("med", PriorityMedium)))
	require.NoError(t, q.Enqueue(ctx, makeJob("lo", PriorityLow)))

	high, medium, low, err := q.QueueDepthByLane(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(1), high)
	assert.Equal(t, int64(1), medium)
	assert.Equal(t, int64(1), low)
}

// ── Dequeue ─────────────────────────────────────────────────────────────────

func TestDequeue_EmptyReturnsNil(t *testing.T) {
	q, _ := newTestQueue(t)
	job, err := q.Dequeue(context.Background())
	require.NoError(t, err)
	assert.Nil(t, job)
}

func TestDequeue_ReturnsEnqueuedJob(t *testing.T) {
	q, _ := newTestQueue(t)
	ctx := context.Background()

	original := makeJob("x1", PriorityMedium)
	require.NoError(t, q.Enqueue(ctx, original))

	claimed, err := q.Dequeue(ctx)
	require.NoError(t, err)
	require.NotNil(t, claimed)
	assert.Equal(t, original.ID, claimed.ID)
	assert.Equal(t, original.Type, claimed.Type)
}

func TestDequeue_PriorityOrder(t *testing.T) {
	q, _ := newTestQueue(t)
	ctx := context.Background()

	// Enqueue in ascending priority; expect descending dequeue order.
	require.NoError(t, q.Enqueue(ctx, makeJob("lo", PriorityLow)))
	require.NoError(t, q.Enqueue(ctx, makeJob("med", PriorityMedium)))
	require.NoError(t, q.Enqueue(ctx, makeJob("hi", PriorityHigh)))

	first, err := q.Dequeue(ctx)
	require.NoError(t, err)
	assert.Equal(t, "hi", first.ID)

	second, err := q.Dequeue(ctx)
	require.NoError(t, err)
	assert.Equal(t, "med", second.ID)

	third, err := q.Dequeue(ctx)
	require.NoError(t, err)
	assert.Equal(t, "lo", third.ID)
}

// ── Ack ─────────────────────────────────────────────────────────────────────

func TestAck_RemovesFromProcessing(t *testing.T) {
	q, mr := newTestQueue(t)
	ctx := context.Background()

	require.NoError(t, q.Enqueue(ctx, makeJob("ack-1", PriorityMedium)))

	claimed, err := q.Dequeue(ctx)
	require.NoError(t, err)
	require.NotNil(t, claimed)

	assert.NotEmpty(t, mr.HGet(keyProcessing, claimed.ID))

	require.NoError(t, q.Ack(ctx, claimed))

	assert.Empty(t, mr.HGet(keyProcessing, claimed.ID))
	lockVal, _ := mr.Get(keyLockPrefix + claimed.ID)
	assert.Empty(t, lockVal)
}

// ── Nack ─────────────────────────────────────────────────────────────────────

func TestNack_ReleasesLockAndProcessing(t *testing.T) {
	q, mr := newTestQueue(t)
	ctx := context.Background()

	require.NoError(t, q.Enqueue(ctx, makeJob("nack-1", PriorityLow)))

	claimed, err := q.Dequeue(ctx)
	require.NoError(t, err)
	require.NotNil(t, claimed)

	require.NoError(t, q.Nack(ctx, claimed))

	assert.Empty(t, mr.HGet(keyProcessing, claimed.ID))
	nackLockVal, _ := mr.Get(keyLockPrefix + claimed.ID)
	assert.Empty(t, nackLockVal)
}

// ── MoveToDLQ ────────────────────────────────────────────────────────────────

func TestMoveToDLQ_AppearsInDLQ(t *testing.T) {
	q, _ := newTestQueue(t)
	ctx := context.Background()

	require.NoError(t, q.Enqueue(ctx, makeJob("dlq-1", PriorityHigh)))

	claimed, err := q.Dequeue(ctx)
	require.NoError(t, err)
	require.NotNil(t, claimed)

	require.NoError(t, q.MoveToDLQ(ctx, claimed, errors.New("permanent failure")))

	size, err := q.DLQSize(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(1), size)
}

func TestMoveToDLQ_SetsStatusAndTime(t *testing.T) {
	q, _ := newTestQueue(t)
	ctx := context.Background()

	j := makeJob("dlq-2", PriorityMedium)
	require.NoError(t, q.Enqueue(ctx, j))

	claimed, err := q.Dequeue(ctx)
	require.NoError(t, err)

	require.NoError(t, q.MoveToDLQ(ctx, claimed, errors.New("boom")))
	assert.Equal(t, StatusDead, claimed.Status)
	assert.NotNil(t, claimed.FailedAt)
	assert.Equal(t, "boom", claimed.ErrorMessage)
}

func TestDLQSize_EmptyInitially(t *testing.T) {
	q, _ := newTestQueue(t)
	size, err := q.DLQSize(context.Background())
	require.NoError(t, err)
	assert.Equal(t, int64(0), size)
}

// ── EnqueueDelayed ───────────────────────────────────────────────────────────

func TestEnqueueDelayed_NotInPriorityLane(t *testing.T) {
	q, _ := newTestQueue(t)
	ctx := context.Background()

	require.NoError(t, q.EnqueueDelayed(ctx, makeJob("d1", PriorityMedium), time.Now().Add(1*time.Hour)))

	depth, err := q.QueueDepth(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(0), depth)
}

// ── DrainDelayed ─────────────────────────────────────────────────────────────

func TestDrainDelayed_MovesReadyJobs(t *testing.T) {
	q, mr := newTestQueue(t)
	ctx := context.Background()

	past := time.Now().Add(-5 * time.Minute)
	require.NoError(t, q.EnqueueDelayed(ctx, makeJob("d2", PriorityLow), past))

	// Advance miniredis clock beyond the scheduled time.
	mr.FastForward(10 * time.Minute)

	moved, err := q.DrainDelayed(ctx, time.Now().Add(10*time.Minute), 10)
	require.NoError(t, err)
	assert.Equal(t, 1, moved)

	depth, err := q.QueueDepth(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(1), depth)
}

func TestDrainDelayed_FutureJobsNotMoved(t *testing.T) {
	q, _ := newTestQueue(t)
	ctx := context.Background()

	future := time.Now().Add(1 * time.Hour)
	require.NoError(t, q.EnqueueDelayed(ctx, makeJob("d3", PriorityMedium), future))

	moved, err := q.DrainDelayed(ctx, time.Now(), 10)
	require.NoError(t, err)
	assert.Equal(t, 0, moved)

	depth, err := q.QueueDepth(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(0), depth)
}
