package main

import (
	"context"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"taskfire/worker/dag"
	"taskfire/worker/metrics"
	"taskfire/worker/pool"
	"taskfire/worker/processor"
	"taskfire/worker/queue"
	"taskfire/worker/scheduler"
)

func main() {
	// ── Dotenv ────────────────────────────────────────────────────────────────
	// Load .env if present; silently ignore missing file so the binary works
	// in environments where config is injected via real env vars.
	_ = godotenv.Load()

	// ── Logger ────────────────────────────────────────────────────────────────
	logger := zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339}).
		With().Timestamp().Str("service", "taskfire-worker").Logger()
	log.Logger = logger

	// ── Config ────────────────────────────────────────────────────────────────
	redisURL := getEnv("REDIS_URL", "redis://localhost:6379")
	dbURL := getEnv("DATABASE_URL", "postgresql://taskfire:taskfire@localhost:5432/taskfire")
	minWorkers, _ := strconv.Atoi(getEnv("WORKER_MIN", "4"))
	maxWorkers, _ := strconv.Atoi(getEnv("WORKER_MAX", "32"))
	metricsPort := getEnv("METRICS_PORT", "9090")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// ── Redis queue ───────────────────────────────────────────────────────────
	q, err := connectRedis(redisURL, logger)
	if err != nil {
		logger.Fatal().Err(err).Msg("failed to connect to Redis after retries")
	}
	defer q.Close()

	// ── Postgres pool ─────────────────────────────────────────────────────────
	dbPool, err := connectPostgres(ctx, dbURL, logger)
	if err != nil {
		logger.Fatal().Err(err).Msg("failed to connect to Postgres after retries")
	}
	defer dbPool.Close()

	// ── Processor ─────────────────────────────────────────────────────────────
	store := processor.NewPostgresStore(dbPool)
	proc := processor.New(q, store, logger)

	// ── DAG dependency engine ─────────────────────────────────────────────────
	dagEngine := dag.NewEngine(dbPool, logger)
	proc.SetDependencyChecker(dagEngine)

	// Register any custom retry configs here, e.g.:
	// proc.RegisterRetryConfig("email", retry.Config{
	//     BaseDelay: 1 * time.Second, MaxDelay: 2 * time.Minute, MaxRetries: 8, Multiplier: 2.0,
	// })

	// ── Metrics server ────────────────────────────────────────────────────────
	go func() {
		if err := metrics.StartServer(ctx, metricsPort, logger); err != nil {
			logger.Error().Err(err).Msg("metrics server exited with error")
		}
	}()

	// ── Queue metrics collection ──────────────────────────────────────────────
	go metrics.CollectQueueMetrics(ctx, q, 5*time.Second, logger)

	// ── Worker pool ───────────────────────────────────────────────────────────
	poolCfg := pool.DefaultConfig()
	poolCfg.MinWorkers = minWorkers
	poolCfg.MaxWorkers = maxWorkers

	wp := pool.NewPool(poolCfg, q, proc, logger)
	wp.Start(ctx)

	// ── Scheduler ─────────────────────────────────────────────────────────────
	sched := scheduler.NewScheduler(q, logger)
	go sched.Start(ctx)

	logger.Info().
		Int("min_workers", minWorkers).
		Int("max_workers", maxWorkers).
		Str("metrics_port", metricsPort).
		Msg("taskfire worker started")

	// ── Graceful shutdown ─────────────────────────────────────────────────────
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	sig := <-sigCh
	logger.Info().Str("signal", sig.String()).Msg("shutdown signal received")

	cancel() // stops fetcher, scaler, scheduler, metrics collection, and all workers
	wp.Wait() // waits for every in-flight job to finish

	logger.Info().Msg("taskfire worker stopped cleanly")
}

// ── Connection helpers ────────────────────────────────────────────────────────

// connectRedis retries the Redis connection up to 5 times with exponential
// backoff before returning the last error.
func connectRedis(url string, logger zerolog.Logger) (*queue.RedisQueue, error) {
	var (
		q   *queue.RedisQueue
		err error
	)
	for attempt := 1; attempt <= 5; attempt++ {
		q, err = queue.NewRedisQueue(url, logger)
		if err == nil {
			return q, nil
		}
		wait := time.Duration(attempt) * 2 * time.Second
		logger.Warn().
			Err(err).
			Int("attempt", attempt).
			Dur("retry_in", wait).
			Msg("redis connection failed; retrying")
		time.Sleep(wait)
	}
	return nil, err
}

// connectPostgres retries the Postgres connection up to 5 times with
// exponential backoff before returning the last error.
func connectPostgres(ctx context.Context, url string, logger zerolog.Logger) (*pgxpool.Pool, error) {
	var (
		pool *pgxpool.Pool
		err  error
	)
	for attempt := 1; attempt <= 5; attempt++ {
		pool, err = pgxpool.New(ctx, url)
		if err == nil {
			if pingErr := pool.Ping(ctx); pingErr == nil {
				logger.Info().Str("url", url).Msg("postgres connected")
				return pool, nil
			} else {
				pool.Close()
				err = pingErr
			}
		}
		wait := time.Duration(attempt) * 2 * time.Second
		logger.Warn().
			Err(err).
			Int("attempt", attempt).
			Dur("retry_in", wait).
			Msg("postgres connection failed; retrying")
		time.Sleep(wait)
	}
	return nil, err
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
