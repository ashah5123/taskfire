package retry

import (
	"math"
	"time"
)

// ExponentialBackoff computes retry delays with jitter.
type ExponentialBackoff struct {
	initial    time.Duration
	max        time.Duration
	multiplier float64
}

func NewExponentialBackoff(initial, max time.Duration, multiplier float64) *ExponentialBackoff {
	return &ExponentialBackoff{initial: initial, max: max, multiplier: multiplier}
}

// Delay returns the wait duration for the given attempt (0-indexed).
func (b *ExponentialBackoff) Delay(attempt int) time.Duration {
	if attempt <= 0 {
		return 0
	}
	delay := float64(b.initial) * math.Pow(b.multiplier, float64(attempt-1))
	if delay > float64(b.max) {
		delay = float64(b.max)
	}
	return time.Duration(delay)
}
