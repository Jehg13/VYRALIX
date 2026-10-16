CREATE TABLE IF NOT EXISTS media_scene_details (
  scene_id TEXT PRIMARY KEY REFERENCES media_scenes(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  narrative_goal TEXT NOT NULL DEFAULT '',
  dialogue TEXT NOT NULL DEFAULT '',
  shot_type TEXT NOT NULL DEFAULT '',
  camera_movement TEXT NOT NULL DEFAULT '',
  action_description TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL DEFAULT '',
  lighting TEXT NOT NULL DEFAULT '',
  palette TEXT NOT NULL DEFAULT '',
  continuity_before TEXT NOT NULL DEFAULT '',
  continuity_after TEXT NOT NULL DEFAULT '',
  audio_notes TEXT NOT NULL DEFAULT '',
  visual_pending INTEGER NOT NULL DEFAULT 1 CHECK (visual_pending IN (0, 1))
);

CREATE TABLE IF NOT EXISTS media_project_plans (
  project_id TEXT PRIMARY KEY REFERENCES media_projects(id) ON DELETE CASCADE,
  narrative_goal TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('gemini', 'groq', 'ollama')),
  model TEXT,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (4);
