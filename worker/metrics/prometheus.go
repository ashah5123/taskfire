package metrics

import (
	"log"
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	JobsProcessed = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "taskfire_jobs_processed_total",
		Help: "Total number of jobs processed.",
	}, []string{"type"})

	JobsFailed = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "taskfire_jobs_failed_total",
		Help: "Total number of jobs failed.",
	}, []string{"type"})

	JobDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "taskfire_job_duration_seconds",
		Help:    "Job processing duration in seconds.",
		Buckets: prometheus.DefBuckets,
	}, []string{"type"})

	ActiveWorkers = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "taskfire_active_workers",
		Help: "Number of workers currently processing jobs.",
	})

	QueueDepth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "taskfire_queue_depth",
		Help: "Number of jobs waiting in queue.",
	}, []string{"queue"})
)

func init() {
	prometheus.MustRegister(JobsProcessed, JobsFailed, JobDuration, ActiveWorkers, QueueDepth)
}

func StartServer(port string) {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})
	log.Printf("Metrics server listening on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatalf("metrics server failed: %v", err)
	}
}
