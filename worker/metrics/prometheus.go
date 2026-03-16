package metrics

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/zerolog"
)

// ns is the shared Prometheus metric namespace.
const ns = "taskfire"

var (
	// JobsProcessed counts jobs that completed successfully.
	// Labels: job_type, priority (high|medium|low).
	JobsProcessed = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: ns,
		Name:      "jobs_processed_total",
		Help:      "Total number of jobs processed successfully, labelled by type and priority.",
	}, []string{"job_type", "priority"})

	// JobsFailed counts jobs that failed permanently (moved to DLQ or dropped).
	// Labels: job_type, failure_reason.
	JobsFailed = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: ns,
		Name:      "jobs_failed_total",
		Help:      "Total number of jobs that failed permanently, labelled by type and failure reason.",
	}, []string{"job_type", "failure_reason"})

	// RetryAttempts counts individual retry attempts (not original executions).
	// Labels: job_type.
	RetryAttempts = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: ns,
		Name:      "retry_attempts_total",
		Help:      "Total number of job retry attempts, labelled by type.",
	}, []string{"job_type"})

	// JobDuration records wall-clock handler execution time.
	// Labels: job_type.
	JobDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: ns,
		Name:      "job_processing_duration_seconds",
		Help:      "Handler execution time in seconds, labelled by job type.",
		// Buckets cover fast in-process work (5 ms) through long-running jobs (60 s).
		Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30, 60},
	}, []string{"job_type"})

	// QueueDepth is the number of pending jobs in each priority lane.
	// Labels: priority (high|medium|low).
	QueueDepth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: ns,
		Name:      "queue_depth_gauge",
		Help:      "Number of jobs waiting in each priority lane.",
	}, []string{"priority"})

	// WorkerUtilization is 1.0 while a worker is executing a handler, 0.0 when idle.
	// Labels: worker_id.
	WorkerUtilization = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: ns,
		Name:      "worker_utilization_gauge",
		Help:      "Per-worker utilization: 1.0 when busy executing a handler, 0.0 when idle.",
	}, []string{"worker_id"})

	// DLQSize is the number of entries currently sitting in the dead-letter queue.
	DLQSize = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: ns,
		Name:      "dead_letter_queue_size",
		Help:      "Number of permanently failed jobs in the dead-letter queue.",
	})

	// ActiveWorkers is the instantaneous count of workers executing a handler.
	// Kept alongside WorkerUtilization for easy dashboard aggregations.
	ActiveWorkers = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: ns,
		Name:      "active_workers_total",
		Help:      "Number of worker goroutines currently executing a job handler.",
	})
)

func init() {
	prometheus.MustRegister(
		JobsProcessed,
		JobsFailed,
		RetryAttempts,
		JobDuration,
		QueueDepth,
		WorkerUtilization,
		DLQSize,
		ActiveWorkers,
	)
}

// PriorityLabel converts a numeric priority value to its human-readable lane name.
func PriorityLabel(priority int) string {
	switch {
	case priority >= 300:
		return "high"
	case priority >= 200:
		return "medium"
	default:
		return "low"
	}
}

// WorkerLabel converts an integer worker ID to a Prometheus label string.
func WorkerLabel(id int) string {
	return strconv.Itoa(id)
}

// GaugeSource is the interface the job broker must satisfy for queue-level
// gauge collection. Both methods are called periodically by CollectQueueMetrics.
type GaugeSource interface {
	// QueueDepthByLane returns the number of pending jobs in each priority lane.
	QueueDepthByLane(ctx context.Context) (high, medium, low int64, err error)
	// DLQSize returns the number of entries in the dead-letter sorted set.
	DLQSize(ctx context.Context) (int64, error)
}

// CollectQueueMetrics runs a background goroutine that updates QueueDepth
// and DLQSize gauges every interval by calling src. It exits when ctx
// is cancelled or expires.
func CollectQueueMetrics(ctx context.Context, src GaugeSource, interval time.Duration, logger zerolog.Logger) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	collect := func() {
		high, med, low, err := src.QueueDepthByLane(ctx)
		if err != nil {
			if ctx.Err() == nil {
				logger.Error().Err(err).Msg("metrics: queue depth collection failed")
			}
			return
		}
		QueueDepth.WithLabelValues("high").Set(float64(high))
		QueueDepth.WithLabelValues("medium").Set(float64(med))
		QueueDepth.WithLabelValues("low").Set(float64(low))

		dlq, err := src.DLQSize(ctx)
		if err != nil {
			if ctx.Err() == nil {
				logger.Error().Err(err).Msg("metrics: DLQ size collection failed")
			}
			return
		}
		DLQSize.Set(float64(dlq))
	}

	// Collect immediately on start so dashboards see values right away.
	collect()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			collect()
		}
	}
}

// StartServer starts the Prometheus /metrics and /health HTTP endpoints on
// the given port. It blocks until the server exits. When ctx is cancelled,
// it initiates a graceful shutdown with a 10-second timeout.
func StartServer(ctx context.Context, port string, logger zerolog.Logger) error {
	mux := http.NewServeMux()

	// Use OpenMetrics format when the client negotiates it (e.g. Prometheus ≥ 2.x).
	mux.Handle("/metrics", promhttp.HandlerFor(
		prometheus.DefaultGatherer,
		promhttp.HandlerOpts{
			EnableOpenMetrics: true,
			ErrorLog:          &promErrLogger{logger},
		},
	))

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, `{"status":"ok"}`)
	})

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Shut down gracefully when the parent context is cancelled.
	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutCtx); err != nil {
			logger.Error().Err(err).Msg("metrics server: graceful shutdown failed")
		}
	}()

	logger.Info().Str("port", port).Msg("metrics server listening")

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("metrics server on :%s: %w", port, err)
	}
	return nil
}

// promErrLogger bridges promhttp's error logger to zerolog.
type promErrLogger struct{ log zerolog.Logger }

func (l *promErrLogger) Println(v ...interface{}) {
	l.log.Error().Msgf("%v", fmt.Sprint(v...))
}
