-- ── Extensions ────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Enum types ────────────────────────────────────────────────────────────────

-- Status values match the Go worker constants (StatusActive="active", StatusDead="dead")
CREATE TYPE job_status AS ENUM (
    'pending',
    'active',
    'completed',
    'failed',
    'dead'
);

-- ── updated_at trigger function ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── jobs ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jobs (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    type                TEXT         NOT NULL,
    payload             JSONB        NOT NULL DEFAULT '{}',
    -- priority stored as integer: 300=high, 200=medium, 100=low
    priority            INTEGER      NOT NULL DEFAULT 200,
    status              job_status   NOT NULL DEFAULT 'pending',
    retry_count         INTEGER      NOT NULL DEFAULT 0,
    max_retries         INTEGER      NOT NULL DEFAULT 3,
    error               TEXT,
    dependencies        JSONB        NOT NULL DEFAULT '[]',
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    scheduled_at        TIMESTAMPTZ,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    failed_at           TIMESTAMPTZ,

    CONSTRAINT retry_count_non_negative  CHECK (retry_count  >= 0),
    CONSTRAINT max_retries_non_negative  CHECK (max_retries  >= 0),
    CONSTRAINT retry_count_lte_max       CHECK (retry_count  <= max_retries)
);

CREATE TRIGGER trg_jobs_updated_at
    BEFORE UPDATE ON jobs
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Covering index for the queue-claim query: pending jobs ordered by priority
-- and creation time (FIFO within the same priority).
CREATE INDEX IF NOT EXISTS idx_jobs_status_priority_created
    ON jobs (status, priority DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_jobs_status
    ON jobs (status);

CREATE INDEX IF NOT EXISTS idx_jobs_priority
    ON jobs (priority);

CREATE INDEX IF NOT EXISTS idx_jobs_created_at
    ON jobs (created_at DESC);

-- Partial index: only rows that have a future schedule are queryable by
-- the delayed-job poller without scanning the full table.
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_at
    ON jobs (scheduled_at ASC)
    WHERE scheduled_at IS NOT NULL AND status = 'pending';

-- ── job_dependencies ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_dependencies (
    job_id            UUID        NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    depends_on_job_id UUID        NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (job_id, depends_on_job_id),

    -- A job cannot depend on itself.
    CONSTRAINT no_self_dependency CHECK (job_id <> depends_on_job_id)
);

CREATE INDEX IF NOT EXISTS idx_job_dependencies_job_id
    ON job_dependencies (job_id);

CREATE INDEX IF NOT EXISTS idx_job_dependencies_depends_on
    ON job_dependencies (depends_on_job_id);

-- ── job_logs ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_logs (
    id         BIGSERIAL   PRIMARY KEY,
    job_id     UUID        NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    level      TEXT        NOT NULL DEFAULT 'info',
    message    TEXT        NOT NULL,
    metadata   JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT level_valid CHECK (level IN ('debug', 'info', 'warn', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_job_logs_job_id
    ON job_logs (job_id);

CREATE INDEX IF NOT EXISTS idx_job_logs_job_id_created_at
    ON job_logs (job_id, created_at DESC);

-- ── job_metrics ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_metrics (
    id                     BIGSERIAL        PRIMARY KEY,
    recorded_at            TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    queue_depth_high       INTEGER          NOT NULL DEFAULT 0,
    queue_depth_medium     INTEGER          NOT NULL DEFAULT 0,
    queue_depth_low        INTEGER          NOT NULL DEFAULT 0,
    jobs_processed         INTEGER          NOT NULL DEFAULT 0,
    jobs_failed            INTEGER          NOT NULL DEFAULT 0,
    avg_processing_time_ms DOUBLE PRECISION,

    CONSTRAINT queue_depth_high_non_negative   CHECK (queue_depth_high   >= 0),
    CONSTRAINT queue_depth_medium_non_negative CHECK (queue_depth_medium >= 0),
    CONSTRAINT queue_depth_low_non_negative    CHECK (queue_depth_low    >= 0),
    CONSTRAINT jobs_processed_non_negative     CHECK (jobs_processed     >= 0),
    CONSTRAINT jobs_failed_non_negative        CHECK (jobs_failed        >= 0)
);

-- Metrics are always queried newest-first for dashboards and time-range windows.
CREATE INDEX IF NOT EXISTS idx_job_metrics_recorded_at
    ON job_metrics (recorded_at DESC);

-- ── cron_jobs ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cron_jobs (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL UNIQUE,
    schedule    TEXT        NOT NULL,
    job_type    TEXT        NOT NULL,
    payload     JSONB       NOT NULL DEFAULT '{}',
    -- priority stored as integer: 300=high, 200=medium, 100=low
    priority    INTEGER     NOT NULL DEFAULT 200,
    enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_run_at TIMESTAMPTZ
);

CREATE TRIGGER trg_cron_jobs_updated_at
    BEFORE UPDATE ON cron_jobs
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ── Views ──────────────────────────────────────────────────────────────────────

-- Convenience view used by the API /metrics/summary endpoint.
CREATE OR REPLACE VIEW job_status_counts AS
SELECT
    COUNT(*) FILTER (WHERE status = 'pending')   AS pending,
    COUNT(*) FILTER (WHERE status = 'active')    AS active,
    COUNT(*) FILTER (WHERE status = 'completed') AS completed,
    COUNT(*) FILTER (WHERE status = 'failed')    AS failed,
    COUNT(*) FILTER (WHERE status = 'dead')      AS dead,
    COUNT(*) FILTER (WHERE status IN ('completed', 'failed', 'dead')) AS total_processed,
    ROUND(
        AVG(
            EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
        ) FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL)
    ) AS avg_processing_ms
FROM jobs;

-- ── Seed data ──────────────────────────────────────────────────────────────────

INSERT INTO cron_jobs (name, schedule, job_type, payload, priority) VALUES
    ('heartbeat', '*/5 * * * *', 'noop', '{"task": "heartbeat"}', 100)
ON CONFLICT (name) DO NOTHING;
