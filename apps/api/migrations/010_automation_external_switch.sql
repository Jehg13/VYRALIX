BEGIN;

CREATE TABLE automation_tasks_new (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('research', 'proposal', 'image_generation', 'media_preflight')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_for_authorization', 'waiting_for_external_enabled', 'waiting_for_quota', 'succeeded', 'failed', 'cancelled')),
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

INSERT INTO automation_tasks_new (
  id, idempotency_key, request_hash, type, status, stage, params_json, result_json,
  error_code, provider, model, is_external, attempts, max_attempts, attempt_key,
  last_attempt_at, next_attempt_at, cancel_requested, related_resource_id, created_at, updated_at
)
SELECT
  id, idempotency_key, request_hash, type, status, stage, params_json, result_json,
  error_code, provider, model, is_external, attempts, max_attempts, attempt_key,
  last_attempt_at, next_attempt_at, cancel_requested, related_resource_id, created_at, updated_at
FROM automation_tasks;

DROP TABLE automation_tasks;
ALTER TABLE automation_tasks_new RENAME TO automation_tasks;
CREATE INDEX automation_tasks_status_idx ON automation_tasks(status, created_at);
CREATE INDEX automation_tasks_related_idx ON automation_tasks(related_resource_id);

CREATE TABLE IF NOT EXISTS automation_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  external_operations_enabled INTEGER NOT NULL DEFAULT 0 CHECK (external_operations_enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO automation_settings (id, external_operations_enabled, updated_at)
VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

UPDATE automation_tasks SET status = 'waiting_for_external_enabled',
  stage = 'Autorizada; esperando activación global'
WHERE status = 'queued' AND is_external = 1;

INSERT OR IGNORE INTO schema_migrations (version) VALUES (10);

COMMIT;
