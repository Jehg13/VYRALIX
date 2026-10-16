import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { db, dbPath } from './db.js';
import { createProviderRouter } from './ai/provider-router.js';
import { createAiService } from './ai/service.js';
import { createMediaService } from './media/service.js';

const postStatuses = [
  'idea', 'draft', 'pending_review', 'approved', 'scheduled',
  'publishing', 'published', 'error', 'archived',
];
const transitions = {
  idea: ['draft', 'archived'],
  draft: ['idea', 'pending_review', 'archived'],
  pending_review: ['draft', 'approved', 'archived'],
  approved: ['draft', 'scheduled', 'archived'],
  scheduled: ['approved', 'archived'],
  publishing: ['error', 'published'],
  published: ['archived'],
  error: ['draft', 'approved', 'scheduled', 'archived'],
  archived: ['draft'],
};

const postInput = z.object({
  title: z.string().trim().min(1).max(160),
  platform: z.string().trim().min(1).max(40).default('TikTok'),
  category: z.string().trim().min(1).max(80),
  body: z.string().max(5000).default(''),
  hashtags: z.string().max(1000).default(''),
  source: z.string().trim().max(500).default('Idea propia'),
  status: z.enum(postStatuses).default('draft'),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
});
const createPostInput = postInput.extend({ status: z.enum(['idea', 'draft']).default('draft') });

const statusInput = z.object({ status: z.enum(postStatuses) });
const jobInput = z.object({ postId: z.string().uuid() });

function now() {
  return new Date().toISOString();
}

function toPost(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    platform: row.platform,
    category: row.category,
    body: row.body,
    hashtags: row.hashtags,
    source: row.source,
    status: row.status,
    scheduledAt: row.scheduled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePostBody(body) {
  const parsed = postInput.safeParse(body);
  if (!parsed.success) return { error: parsed.error.flatten() };
  if (parsed.data.status === 'scheduled' && !parsed.data.scheduledAt) {
    return { error: { fieldErrors: { scheduledAt: ['Indica fecha y hora para programar.'] } } };
  }
  return { data: parsed.data };
}

function createRateLimiter(maxRequests, windowMs, message) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = req.ip || 'local';
    const current = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || current - bucket.startedAt >= windowMs) {
      bucket = { startedAt: current, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maxRequests) {
      return res.status(429).json({ error: message, retryAfterSeconds: Math.ceil((windowMs - (current - bucket.startedAt)) / 1000) });
    }
    if (buckets.size > 1000) {
      for (const [address, entry] of buckets) {
        if (current - entry.startedAt >= windowMs) buckets.delete(address);
      }
    }
    next();
  };
}

export function createApp({
  aiRouter = createProviderRouter({ database: db }),
  voiceEngine,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  const allowedOrigins = new Set([
    process.env.WEB_ORIGIN || 'http://127.0.0.1:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ]);
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error('Origen CORS no permitido.'));
    },
  }));
  const mediaService = createMediaService({ database: db, dataDirectory: dirname(dbPath), aiRouter, voiceEngine });
  mediaService.registerUploadRoute(app);
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/v1/health', (_req, res) => res.json({ status: 'ok' }));
  const aiService = createAiService({ database: db, router: aiRouter });
  mediaService.registerRoutes(
    app,
    createRateLimiter(4, 60_000, 'Límite de planificación audiovisual alcanzado. Espera un minuto antes de volver a solicitar.'),
    createRateLimiter(20, 60_000, 'Límite de generación de voz local alcanzado. Espera un minuto antes de volver a solicitar.'),
  );
  aiService.registerRoutes(
    app,
    createRateLimiter(8, 60_000, 'Límite local de generación alcanzado. Espera un minuto antes de volver a solicitar.'),
    createRateLimiter(12, 60_000, 'Límite local de comprobaciones alcanzado. Espera un minuto.'),
  );

  app.post('/api/v1/backup', async (_req, res, next) => {
    try {
      const directory = join(dirname(dbPath), 'backups');
      await mkdir(directory, { recursive: true });
      const destination = join(directory, `vyralix-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
      await db.backup(destination);
      res.status(201).json({ path: destination, createdAt: now() });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/v1/posts', (req, res) => {
    const query = z.object({
      search: z.string().optional(),
      status: z.enum(postStatuses).optional(),
    }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'Filtros inválidos.' });

    const clauses = [];
    const values = [];
    if (query.data.status) {
      clauses.push('status = ?');
      values.push(query.data.status);
    }
    if (query.data.search?.trim()) {
      clauses.push('(title LIKE ? OR body LIKE ? OR category LIKE ?)');
      const term = `%${query.data.search.trim()}%`;
      values.push(term, term, term);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM posts ${where} ORDER BY updated_at DESC`).all(...values);
    res.json(rows.map(toPost));
  });

  app.post('/api/v1/posts', (req, res) => {
    const parsed = createPostInput.safeParse(req.body);
    if (parsed.error) return res.status(400).json({ error: 'Revisa los campos del contenido.', details: parsed.error });
    const timestamp = now();
    const id = randomUUID();
    const post = parsed.data;
    db.prepare(`INSERT INTO posts
      (id, title, platform, category, body, hashtags, source, status, scheduled_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, post.title, post.platform, post.category, post.body, post.hashtags,
      post.source, post.status, post.scheduledAt ?? null, timestamp, timestamp,
    );
    res.status(201).json(toPost(db.prepare('SELECT * FROM posts WHERE id = ?').get(id)));
  });

  app.get('/api/v1/posts/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'No se encontró el contenido.' });
    res.json(toPost(row));
  });

  app.put('/api/v1/posts/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'No se encontró el contenido.' });
    const parsed = parsePostBody(req.body);
    if (parsed.error) return res.status(400).json({ error: 'Revisa los campos del contenido.', details: parsed.error });
    if (parsed.data.status !== existing.status && !transitions[existing.status].includes(parsed.data.status)) {
      return res.status(409).json({ error: `No se permite cambiar de "${existing.status}" a "${parsed.data.status}".` });
    }
    const post = parsed.data;
    db.prepare(`UPDATE posts SET title = ?, platform = ?, category = ?, body = ?, hashtags = ?,
      source = ?, status = ?, scheduled_at = ?, updated_at = ? WHERE id = ?`).run(
      post.title, post.platform, post.category, post.body, post.hashtags,
      post.source, post.status, post.scheduledAt ?? null, now(), req.params.id,
    );
    res.json(toPost(db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id)));
  });

  app.patch('/api/v1/posts/:id/status', (req, res) => {
    const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'No se encontró el contenido.' });
    const parsed = statusInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Estado inválido.' });
    if (!transitions[row.status].includes(parsed.data.status)) {
      return res.status(409).json({ error: `No se permite cambiar de "${row.status}" a "${parsed.data.status}".` });
    }
    if (parsed.data.status === 'scheduled' && !row.scheduled_at) {
      return res.status(400).json({ error: 'Programa una fecha antes de cambiar el estado.' });
    }
    db.prepare('UPDATE posts SET status = ?, updated_at = ? WHERE id = ?')
      .run(parsed.data.status, now(), req.params.id);
    res.json(toPost(db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id)));
  });

  app.delete('/api/v1/posts/:id', (req, res) => {
    const existing = db.prepare('SELECT status FROM posts WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'No se encontró el contenido.' });
    if (existing.status === 'publishing' || existing.status === 'published') {
      return res.status(409).json({ error: 'No se puede eliminar contenido en publicación o ya publicado.' });
    }
    if (db.prepare('SELECT 1 FROM jobs WHERE post_id = ? LIMIT 1').get(req.params.id)) {
      return res.status(409).json({ error: 'Este contenido tiene trabajos registrados. Archívalo para conservar el historial.' });
    }
    if (db.prepare('SELECT 1 FROM media_projects WHERE post_id = ? LIMIT 1').get(req.params.id)) {
      return res.status(409).json({ error: 'Este contenido está vinculado a un proyecto audiovisual. Conserva el borrador original y archívalo para mantener la relación.' });
    }
    db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });

  app.get('/api/v1/calendar', (req, res) => {
    const parsed = z.object({
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
    }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'El rango del calendario no es válido.' });
    const rows = db.prepare(`SELECT * FROM posts WHERE scheduled_at >= ? AND scheduled_at < ?
      ORDER BY scheduled_at ASC`).all(parsed.data.from, parsed.data.to);
    res.json(rows.map(toPost));
  });

  app.get('/api/v1/jobs', (_req, res) => {
    const rows = db.prepare(`SELECT jobs.*, posts.title AS post_title FROM jobs
      JOIN posts ON posts.id = jobs.post_id ORDER BY jobs.created_at DESC`).all();
    res.json(rows.map((row) => ({
      id: row.id,
      postId: row.post_id,
      postTitle: row.post_title,
      type: row.type,
      status: row.status,
      attempts: row.attempts,
      result: row.result,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })));
  });

  app.post('/api/v1/jobs', (req, res) => {
    const parsed = jobInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Identificador de contenido inválido.' });
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(parsed.data.postId);
    if (!post) return res.status(404).json({ error: 'No se encontró el contenido.' });
    if (!['approved', 'scheduled'].includes(post.status)) {
      return res.status(409).json({ error: 'Solo se puede ejecutar una prueba local para contenido aprobado o programado.' });
    }
    const prior = db.prepare(`SELECT * FROM jobs WHERE post_id = ? AND status IN ('pending', 'processing', 'completed')
      ORDER BY created_at DESC LIMIT 1`).get(post.id);
    if (prior) return res.status(409).json({ error: 'Ya existe un trabajo de prueba para este contenido.', jobId: prior.id });
    const timestamp = now();
    const id = randomUUID();
    db.prepare(`INSERT INTO jobs (id, post_id, type, status, idempotency_key, created_at, updated_at)
      VALUES (?, ?, 'local_test', 'pending', ?, ?, ?)`).run(id, post.id, `local-test:${post.id}`, timestamp, timestamp);
    res.status(201).json({ id, postId: post.id, postTitle: post.title, type: 'local_test', status: 'pending', attempts: 0, result: null, error: null, createdAt: timestamp, updatedAt: timestamp });
  });

  app.get('/api/v1/dashboard', (_req, res) => {
    const counts = Object.fromEntries(postStatuses.map((status) => [status, 0]));
    for (const row of db.prepare('SELECT status, COUNT(*) AS count FROM posts GROUP BY status').all()) {
      counts[row.status] = row.count;
    }
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString();
    const jobs = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status')
      .all().map((row) => [row.status, row.count]));
    const next = db.prepare(`SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_at >= ?
      ORDER BY scheduled_at ASC LIMIT 1`).get(now());
    const activity = db.prepare(`SELECT date(created_at) AS day, COUNT(*) AS count FROM posts
      WHERE created_at >= date('now', '-6 days') GROUP BY date(created_at) ORDER BY day ASC`).all();
    res.json({
      today: {
        scheduled: db.prepare(`SELECT COUNT(*) AS count FROM posts WHERE scheduled_at >= ? AND scheduled_at < ? AND status = 'scheduled'`).get(start, end).count,
        published: db.prepare(`SELECT COUNT(*) AS count FROM posts WHERE updated_at >= ? AND updated_at < ? AND status = 'published'`).get(start, end).count,
      },
      posts: counts,
      jobs,
      nextPost: toPost(next),
      activity,
      generatedAt: now(),
    });
  });

  app.use((req, res) => res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` }));
  app.use((error, _req, res, _next) => {
    console.error(JSON.stringify({ level: 'error', message: error.message, time: now() }));
    if (res.headersSent) return;
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'El cuerpo JSON de la solicitud no es válido.' });
    }
    if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
      return res.status(error.status).json({ error: error.message || 'La solicitud no es válida.' });
    }
    res.status(500).json({ error: 'Ocurrió un error interno. Revisa el registro del servidor.' });
  });
  app.locals.mediaService = mediaService;
  return app;
}

export function processPendingJobs() {
  const job = db.prepare(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`).get();
  if (!job) return false;
  const claimed = db.prepare(`UPDATE jobs SET status = 'processing', attempts = attempts + 1, updated_at = ?
    WHERE id = ? AND status = 'pending'`).run(now(), job.id);
  if (!claimed.changes) return false;
  const result = JSON.stringify({
    mode: 'local_test',
    message: 'Prueba local completada. No se realizó ninguna publicación externa.',
    postId: job.post_id,
  });
  db.prepare(`UPDATE jobs SET status = 'completed', result = ?, updated_at = ? WHERE id = ?`)
    .run(result, now(), job.id);
  console.info(JSON.stringify({ level: 'info', event: 'local_test_completed', jobId: job.id }));
  return true;
}

export function recoverInterruptedJobs() {
  const result = db.prepare(`UPDATE jobs SET status = 'pending', updated_at = ?
    WHERE type = 'local_test' AND status = 'processing'`).run(now());
  if (result.changes) {
    console.info(JSON.stringify({ level: 'info', event: 'local_jobs_recovered', count: result.changes }));
  }
  return result.changes;
}
