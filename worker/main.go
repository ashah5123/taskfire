package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"taskfire/worker/metrics"
	"taskfire/worker/pool"
	"taskfire/worker/queue"
	"taskfire/worker/scheduler"
)

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	redisURL := getEnv("REDIS_URL", "redis://localhost:6379")
	workerCount, _ := strconv.Atoi(getEnv("WORKER_COUNT", "10"))
	metricsPort := getEnv("METRICS_PORT", "9090")

	// Initialize metrics server
	go metrics.StartServer(metricsPort)

	// Initialize Redis queue
	q, err := queue.NewRedisQueue(redisURL)
	if err != nil {
		log.Fatalf("failed to connect to redis: %v", err)
	}
	defer q.Close()

	// Initialize worker pool
	wp := pool.NewWorkerPool(workerCount, q)

	// Initialize scheduler for cron jobs
	sched := scheduler.NewScheduler(q)
	go sched.Start(ctx)

	// Start worker pool
	go wp.Start(ctx)

	log.Printf("Taskfire worker started: %d workers, metrics on :%s", workerCount, metricsPort)

	// Graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("Shutting down worker...")
	cancel()
	wp.Wait()
	log.Println("Worker stopped.")
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
