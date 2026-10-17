CREATE TABLE IF NOT EXISTS automation_tasks (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('research', 'proposal', 'image_generation', 'media_preflight')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_for_authorization', 'waiting_for_quota', 'succeeded', 'failed', 'cancelled')),
  stage TEXT NOT NULL,
  params_json TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  provider TEXT,
  model TEXT,
  is_external INTEGER NOT NULL CHECK (is_external IN (0, 1)),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  attempt_key TEXT,
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  related_resource_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS automation_tasks_status_idx ON automation_tasks(status, created_at);
CREATE INDEX IF NOT EXISTS automation_tasks_related_idx ON automation_tasks(related_resource_id);

CREATE TABLE IF NOT EXISTS automation_provider_state (
  provider TEXT PRIMARY KEY,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'unknown', 'available', 'not_configured', 'rate_limited', 'quota_limited',
    'authentication_error', 'permission_error', 'model_unavailable', 'timeout', 'unavailable'
  )),
  error_code TEXT,
  retry_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_worker_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner_id TEXT,
  expires_at TEXT NOT NULL
);

INSERT OR IGNORE INTO automation_worker_lease (id, owner_id, expires_at)
VALUES (1, NULL, '1970-01-01T00:00:00.000Z');
INSERT OR IGNORE INTO schema_migrations (version) VALUES (9);
