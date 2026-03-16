package retry

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var discardLogger = zerolog.Nop()

func TestConfigFor_ReturnsDefault(t *testing.T) {
	m := NewManager()
	cfg := m.ConfigFor("unknown-type")
	assert.Equal(t, DefaultConfig, cfg)
}

func TestConfigFor_ReturnsRegistered(t *testing.T) {
	m := NewManager()
	custom := Config{
		BaseDelay:  100 * time.Millisecond,
		MaxDelay:   5 * time.Second,
		MaxRetries: 2,
		Multiplier: 3.0,
	}
	m.Register("custom-type", custom)
	assert.Equal(t, custom, m.ConfigFor("custom-type"))
}

func TestConfigFor_UnregisteredTypeStillReturnsDefault(t *testing.T) {
	m := NewManager()
	m.Register("other", DefaultConfig)
	assert.Equal(t, DefaultConfig, m.ConfigFor("not-registered"))
}

func TestShouldRetry_BelowMax(t *testing.T) {
	m := NewManager()
	assert.True(t, m.ShouldRetry("email", 0))
	assert.True(t, m.ShouldRetry("email", DefaultConfig.MaxRetries-1))
}

func TestShouldRetry_AtMax(t *testing.T) {
	m := NewManager()
	assert.False(t, m.ShouldRetry("email", DefaultConfig.MaxRetries))
}

func TestShouldRetry_AboveMax(t *testing.T) {
	m := NewManager()
	assert.False(t, m.ShouldRetry("email", DefaultConfig.MaxRetries+5))
}

func TestShouldRetry_CustomConfig(t *testing.T) {
	m := NewManager()
	m.Register("critical", Config{MaxRetries: 10, BaseDelay: time.Second, MaxDelay: 30 * time.Second, Multiplier: 2})
	assert.True(t, m.ShouldRetry("critical", 9))
	assert.False(t, m.ShouldRetry("critical", 10))
}

func TestDelay_ZeroForNonPositiveAttempt(t *testing.T) {
	m := NewManager()
	assert.Equal(t, time.Duration(0), m.Delay("any", 0))
	assert.Equal(t, time.Duration(0), m.Delay("any", -1))
}

func TestDelay_WithinBounds(t *testing.T) {
	m := NewManager()
	for attempt := 1; attempt <= 10; attempt++ {
		d := m.Delay("email", attempt)
		assert.GreaterOrEqual(t, int64(d), int64(0), "attempt %d delay must be >= 0", attempt)
		assert.LessOrEqual(t, d, DefaultConfig.MaxDelay, "attempt %d delay must be <= MaxDelay", attempt)
	}
}

func TestDelay_CapsAtMaxDelay(t *testing.T) {
	m := NewManager()
	// Attempt 100 would give a ceiling far above MaxDelay; jitter must stay within it.
	d := m.Delay("email", 100)
	assert.LessOrEqual(t, d, DefaultConfig.MaxDelay)
}

func TestDelay_CustomMaxDelay(t *testing.T) {
	m := NewManager()
	maxD := 50 * time.Millisecond
	m.Register("fast", Config{
		BaseDelay:  10 * time.Millisecond,
		MaxDelay:   maxD,
		MaxRetries: 3,
		Multiplier: 2.0,
	})
	for attempt := 1; attempt <= 8; attempt++ {
		d := m.Delay("fast", attempt)
		assert.LessOrEqual(t, d, maxD, "attempt %d", attempt)
	}
}

func TestDelay_Concurrency(t *testing.T) {
	// Calling Delay from multiple goroutines must not race (run with -race).
	m := NewManager()
	done := make(chan struct{})
	for i := 0; i < 20; i++ {
		go func() {
			for j := 0; j < 50; j++ {
				_ = m.Delay("email", j+1)
			}
		}()
	}
	close(done)
	<-done
}

func TestWait_RetriesExhausted(t *testing.T) {
	m := NewManager()
	err := m.Wait(context.Background(), "job-1", "email", DefaultConfig.MaxRetries, errors.New("boom"), discardLogger)
	require.ErrorIs(t, err, ErrRetriesExhausted)
}

func TestWait_Success(t *testing.T) {
	m := NewManager()
	m.Register("instant", Config{
		BaseDelay:  0,
		MaxDelay:   0,
		MaxRetries: 3,
		Multiplier: 2.0,
	})
	err := m.Wait(context.Background(), "job-1", "instant", 1, errors.New("transient"), discardLogger)
	require.NoError(t, err)
}

func TestWait_ContextCancelled(t *testing.T) {
	m := NewManager()
	m.Register("slow", Config{
		BaseDelay:  2 * time.Second,
		MaxDelay:   30 * time.Second,
		MaxRetries: 5,
		Multiplier: 2.0,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	err := m.Wait(ctx, "job-1", "slow", 1, errors.New("timeout test"), discardLogger)
	assert.ErrorIs(t, err, context.DeadlineExceeded)
	// Must return well before the full 2 s delay.
	assert.Less(t, time.Since(start), 500*time.Millisecond)
}

func TestWait_ContextCancelledBeforeStart(t *testing.T) {
	m := NewManager()
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled
	err := m.Wait(ctx, "job-1", "email", 1, errors.New("ctx"), discardLogger)
	// Returns either context error or exhausted (attempt 1 < MaxRetries = 5,
	// so it should try to sleep and immediately find ctx done).
	assert.Error(t, err)
}

func TestRegister_Concurrent(t *testing.T) {
	m := NewManager()
	done := make(chan struct{})
	go func() {
		for i := 0; i < 200; i++ {
			m.Register("concurrent-type", DefaultConfig)
		}
		close(done)
	}()
	for i := 0; i < 200; i++ {
		_ = m.ConfigFor("concurrent-type")
	}
	<-done
}
