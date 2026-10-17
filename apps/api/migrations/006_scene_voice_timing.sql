ALTER TABLE media_scenes ADD COLUMN planned_duration_seconds INTEGER NOT NULL DEFAULT 1
  CHECK (planned_duration_seconds BETWEEN 1 AND 180);
ALTER TABLE media_scenes ADD COLUMN duration_source TEXT NOT NULL DEFAULT 'estimated'
  CHECK (duration_source IN ('estimated', 'manual'));

UPDATE media_scenes
SET planned_duration_seconds = duration_seconds;

INSERT OR IGNORE INTO schema_migrations (version) VALUES (6);
