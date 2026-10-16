CREATE TABLE IF NOT EXISTS media_scene_voice_generations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES media_projects(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES media_scenes(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'windows_sapi'),
  voice_id TEXT NOT NULL,
  language TEXT NOT NULL,
  rate INTEGER NOT NULL CHECK (rate BETWEEN -5 AND 5),
  volume INTEGER NOT NULL CHECK (volume BETWEEN 20 AND 100),
  source_text TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  relative_path TEXT UNIQUE,
  format TEXT NOT NULL DEFAULT 'wav',
  duration_seconds REAL,
  sample_rate INTEGER,
  channels INTEGER,
  size_bytes INTEGER,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS media_scene_voice_project_created_idx
  ON media_scene_voice_generations(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS media_scene_voice_scene_created_idx
  ON media_scene_voice_generations(scene_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS media_scene_voice_one_active_idx
  ON media_scene_voice_generations(scene_id) WHERE is_active = 1;
CREATE UNIQUE INDEX IF NOT EXISTS media_scene_voice_one_processing_idx
  ON media_scene_voice_generations(scene_id) WHERE status IN ('queued', 'processing');

INSERT OR IGNORE INTO schema_migrations (version) VALUES (5);
