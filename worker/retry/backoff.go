package retry

import (
	"context"
	"errors"
	"math"
	"math/rand"
	"sync"
	"time"

	"github.com/rs/zerolog"
)

// ErrRetriesExhausted is returned when a job has consumed all its retry attempts.
var ErrRetriesExhausted = errors.New("all retry attempts exhausted")

// Config holds backoff parameters for a specific job type.
type Config struct {
	// BaseDelay is the initial delay before the first retry.
	BaseDelay time.Duration
	// MaxDelay is the upper bound on computed delay (before jitter).
	MaxDelay time.Duration
	// MaxRetries is the total number of retry attempts allowed (not counting the
	// original execution). A job that fails MaxRetries times is moved to the DLQ.
	MaxRetries int
	// Multiplier is the exponential growth factor applied per attempt.
	Multiplier float64
}

// DefaultConfig is used for any job type that has not registered a custom Config.
var DefaultConfig = Config{
	BaseDelay:  500 * time.Millisecond,
	MaxDelay:   30 * time.Second,
	MaxRetries: 5,
	Multiplier: 2.0,
}

// Manager manages per-job-type retry configurations and computes jittered
// backoff delays. All methods are safe for concurrent use.
type Manager struct {
	mu      sync.RWMutex
	configs map[string]Config

	// rng is used to compute jitter. A dedicated mutex guards it because
	// rand.Rand is not safe for concurrent access.
	rng   *rand.Rand
	rngMu sync.Mutex
}

// NewManager returns a Manager with an empty config registry.
func NewManager() *Manager {
	return &Manager{
		configs: make(map[string]Config),
		rng:     rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

// Register stores a custom Config for jobType, overriding DefaultConfig for
// that type. Calling Register after workers have started is safe.
func (m *Manager) Register(jobType string, cfg Config) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.configs[jobType] = cfg
}

// ConfigFor returns the Config registered for jobType. If no type-specific
// config exists, DefaultConfig is returned.
func (m *Manager) ConfigFor(jobType string) Config {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if cfg, ok := m.configs[jobType]; ok {
		return cfg
	}
	return DefaultConfig
}

// ShouldRetry returns true when retryCount is strictly less than MaxRetries
// for the job type, meaning at least one retry attempt remains.
func (m *Manager) ShouldRetry(jobType string, retryCount int) bool {
	return retryCount < m.ConfigFor(jobType).MaxRetries
}

// Delay computes the full-jitter backoff duration for the given 1-indexed attempt.
//
// Formula (AWS "Full Jitter"):
//
//	ceiling = min(MaxDelay, BaseDelay × Multiplier^attempt)
//	delay   = uniform_random(0, ceiling)
//
// Full jitter produces better aggregate throughput under contention than
// decorrelated jitter because it distributes retries across a wider window,
// preventing thundering-herd effects after a burst of failures.
func (m *Manager) Delay(jobType string, attempt int) time.Duration {
	if attempt <= 0 {
		return 0
	}
	cfg := m.ConfigFor(jobType)
	ceiling := math.Min(
		float64(cfg.MaxDelay),
		float64(cfg.BaseDelay)*math.Pow(cfg.Multiplier, float64(attempt)),
	)
	m.rngMu.Lock()
	jitter := m.rng.Float64() * ceiling
	m.rngMu.Unlock()
	return time.Duration(jitter)
}

// Wait blocks for the computed backoff duration for the given attempt and emits
// a structured log entry. It returns ErrRetriesExhausted when retryCount has
// reached MaxRetries for the job type, or ctx.Err() if the context is cancelled
// while waiting.
//
// retryCount should be the value AFTER incrementing (i.e. the attempt number
// that just failed), so the caller must increment before calling Wait.
func (m *Manager) Wait(
	ctx context.Context,
	jobID, jobType string,
	retryCount int,
	lastErr error,
	logger zerolog.Logger,
) error {
	cfg := m.ConfigFor(jobType)

	if retryCount >= cfg.MaxRetries {
		logger.Error().
			Str("job_id", jobID).
			Str("job_type", jobType).
			Int("retry_count", retryCount).
			Int("max_retries", cfg.MaxRetries).
			Err(lastErr).
			Msg("retries exhausted, routing job to dead-letter queue")
		return ErrRetriesExhausted
	}

	delay := m.Delay(jobType, retryCount)
	nextAt := time.Now().Add(delay)

	logger.Warn().
		Str("job_id", jobID).
		Str("job_type", jobType).
		Int("attempt", retryCount).
		Int("max_retries", cfg.MaxRetries).
		Dur("backoff_delay", delay).
		Time("next_retry_at", nextAt).
		Err(lastErr).
		Msg("job retry scheduled")

	if delay == 0 {
		return nil
	}

	timer := time.NewTimer(delay)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
