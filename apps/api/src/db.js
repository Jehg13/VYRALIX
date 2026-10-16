import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '../../../.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
const dbPath = process.env.VYRALIX_DB_PATH
  ? resolve(process.env.VYRALIX_DB_PATH)
  : resolve(here, '../../../data/vyralix.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
export { dbPath };
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

for (const migrationFile of ['001_initial.sql', '002_ai_engine.sql', '003_media_engine.sql', '004_ai_scene_plans.sql', '005_scene_voice.sql']) {
  db.exec(readFileSync(resolve(here, '../migrations', migrationFile), 'utf8'));
}

export function closeDatabase() {
  db.close();
}
