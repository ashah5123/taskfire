package pool

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/rs/zerolog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"taskfire/worker/processor"
	"taskfire/worker/queue"
)

// noopStore implements processor.Store without a real database.
type noopStore struct{}

func (s *noopStore) UpdateJobStatus(_ context.Context, _ *queue.Job) error { return nil }

func newTestPool(t *testing.T, cfg Config) (*Pool, *miniredis.Miniredis) {
	t.Helper()

	mr := miniredis.RunT(t)
	logger := zerolog.Nop()

	q, err := queue.NewRedisQueue("redis://"+mr.Addr(), logger)
	require.NoError(t, err)
	t.Cleanup(func() { _ = q.Close() })

	store := &noopStore{}
	proc := processor.New(q, store, logger)

	p := NewPool(cfg, q, proc, logger)
	return p, mr
}

// startAndStop starts the pool with a cancellable context and registers cleanup
// so tests don't hang: cancel is called first, then Wait is called.
func startAndStop(t *testing.T, p *Pool) (ctx context.Context, cancel context.CancelFunc) {
	t.Helper()
	ctx, cancel = context.WithCancel(context.Background())
	p.Start(ctx)
	t.Cleanup(func() {
		cancel()
		p.Wait()
	})
	return ctx, cancel
}

// ── DefaultConfig ────────────────────────────────────────────────────────────

func TestDefaultConfig_Values(t *testing.T) {
	cfg := DefaultConfig()
	assert.Equal(t, 4, cfg.MinWorkers)
	assert.Equal(t, 32, cfg.MaxWorkers)
	assert.Equal(t, 64, cfg.JobChannelBuffer)
	assert.Equal(t, 5*time.Second, cfg.ScaleCheckInterval)
	assert.Equal(t, 60*time.Second, cfg.IdleTimeout)
	assert.Equal(t, int64(50), cfg.HighWatermark)
	assert.Equal(t, int64(5), cfg.LowWatermark)
}

// ── NewPool ──────────────────────────────────────────────────────────────────

func TestNewPool_ZeroBufferDefaultsToMaxWorkersTimes2(t *testing.T) {
	cfg := DefaultConfig()
	cfg.JobChannelBuffer = 0

	p, _ := newTestPool(t, cfg)
	assert.Equal(t, cfg.MaxWorkers*2, cap(p.jobCh))
}

func TestNewPool_ExplicitBuffer(t *testing.T) {
	cfg := DefaultConfig()
	cfg.JobChannelBuffer = 16

	p, _ := newTestPool(t, cfg)
	assert.Equal(t, 16, cap(p.jobCh))
}

// ── Start / ActiveWorkerCount ─────────────────────────────────────────────────

func TestStart_SpawnsMinWorkers(t *testing.T) {
	cfg := DefaultConfig()
	cfg.MinWorkers = 3
	cfg.MaxWorkers = 10
	cfg.ScaleCheckInterval = 30 * time.Second // prevent scaling during test

	p, _ := newTestPool(t, cfg)
	startAndStop(t, p)

	assert.Eventually(t, func() bool {
		return p.ActiveWorkerCount() == 3
	}, 500*time.Millisecond, 10*time.Millisecond)
}

func TestActiveWorkerCount_ZeroBeforeStart(t *testing.T) {
	cfg := DefaultConfig()
	p, _ := newTestPool(t, cfg)
	assert.Equal(t, 0, p.ActiveWorkerCount())
}

// ── Stats ─────────────────────────────────────────────────────────────────────

func TestStats_ReturnsPerWorkerStats(t *testing.T) {
	cfg := DefaultConfig()
	cfg.MinWorkers = 2
	cfg.MaxWorkers = 4
	cfg.ScaleCheckInterval = 30 * time.Second

	p, _ := newTestPool(t, cfg)
	startAndStop(t, p)

	assert.Eventually(t, func() bool {
		return len(p.Stats()) == 2
	}, 500*time.Millisecond, 10*time.Millisecond)

	for _, s := range p.Stats() {
		assert.GreaterOrEqual(t, s.ID, 0)
		assert.Equal(t, int64(0), s.JobsProcessed())
		assert.Equal(t, int64(0), s.Errors())
	}
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

func TestPool_GracefulShutdown(t *testing.T) {
	cfg := DefaultConfig()
	cfg.MinWorkers = 2
	cfg.MaxWorkers = 4
	cfg.ScaleCheckInterval = 30 * time.Second

	p, _ := newTestPool(t, cfg)

	ctx, cancel := context.WithCancel(context.Background())
	p.Start(ctx)

	require.Eventually(t, func() bool {
		return p.ActiveWorkerCount() == 2
	}, 500*time.Millisecond, 10*time.Millisecond)

	cancel() // signal shutdown

	done := make(chan struct{})
	go func() {
		p.Wait()
		close(done)
	}()

	select {
	case <-done:
		// clean shutdown
	case <-time.After(5 * time.Second):
		t.Fatal("pool did not shut down within 5 seconds")
	}

	assert.Equal(t, 0, p.ActiveWorkerCount())
}

// ── Job processing ────────────────────────────────────────────────────────────

func TestPool_ProcessesNoopJob(t *testing.T) {
	cfg := DefaultConfig()
	cfg.MinWorkers = 1
	cfg.MaxWorkers = 2
	cfg.ScaleCheckInterval = 30 * time.Second

	p, mr := newTestPool(t, cfg)
	ctx, _ := startAndStop(t, p)

	// Use a second client to the same miniredis to enqueue a job.
	q, err := queue.NewRedisQueue("redis://"+mr.Addr(), zerolog.Nop())
	require.NoError(t, err)
	defer q.Close()

	j := &queue.Job{
		ID:         "test-noop-1",
		Type:       "noop",
		Payload:    map[string]interface{}{},
		Priority:   queue.PriorityMedium,
		Status:     queue.StatusPending,
		MaxRetries: 0,
		CreatedAt:  time.Now(),
	}
	require.NoError(t, q.Enqueue(ctx, j))

	// Wait until the job has been consumed from the queue.
	assert.Eventually(t, func() bool {
		depth, _ := q.QueueDepth(ctx)
		return depth == 0
	}, 5*time.Second, 50*time.Millisecond)
}
