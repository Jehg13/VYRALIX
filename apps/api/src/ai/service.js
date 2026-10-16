import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { generatedVariantSchema, generationInputSchema } from './schema.js';
import { ProviderError, safeProviderError } from './provider-error.js';

const generationIdSchema = z.string().uuid();
const saveVariantSchema = z.object({
  variantIndex: z.number().int().min(0).max(3),
  variant: generatedVariantSchema.optional(),
});
const providerOrderSchema = z.object({
  priority: z.array(z.enum(['gemini', 'groq', 'ollama'])).length(3)
    .refine((items) => new Set(items).size === 3, 'Cada proveedor debe aparecer una sola vez.'),
});

function now() {
  return new Date().toISOString();
}

function publicGeneration(row, database) {
  const result = row.result_json ? JSON.parse(row.result_json) : null;
  const attempts = database.prepare(`SELECT provider, model, task, outcome, error_code, duration_ms, attempt,
    fallback_reason, retry_after_seconds, input_tokens, output_tokens, cost_amount, cost_kind, created_at
    FROM ai_provider_attempts WHERE generation_id = ? ORDER BY created_at ASC, attempt ASC`).all(row.id);
  const variants = result?.variants.map((variant, index) => {
    const state = database.prepare(`SELECT post_id, discarded_at FROM ai_generation_variants
      WHERE generation_id = ? AND variant_index = ?`).get(row.id, index);
    return {
      ...variant,
      index,
      savedPostId: state?.post_id || null,
      discarded: Boolean(state?.discarded_at),
    };
  }) || [];
  return {
    id: row.id,
    request: JSON.parse(row.request_json),
    status: row.status,
    variants,
    provider: result?.provider || null,
    model: result?.model || null,
    attempts: result?.attempts || 0,
    fallbackReason: result?.fallbackReason || null,
    usage: result?.usage || null,
    cost: { kind: 'unknown', amount: null, currency: null },
    providerAttempts: attempts.map((attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      task: attempt.task,
      outcome: attempt.outcome,
      errorCode: attempt.error_code,
      durationMs: attempt.duration_ms,
      attempt: attempt.attempt,
      fallbackReason: attempt.fallback_reason,
      retryAfterSeconds: attempt.retry_after_seconds,
      usage: attempt.input_tokens == null && attempt.output_tokens == null
        ? null
        : { inputTokens: attempt.input_tokens, outputTokens: attempt.output_tokens },
      cost: { kind: attempt.cost_kind, amount: attempt.cost_amount },
      createdAt: attempt.created_at,
    })),
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function createAiService({ database, router }) {
  function registerRoutes(app, generationLimiter, providerCheckLimiter) {
    app.get('/api/v1/ai/providers', (_req, res) => {
      res.json({ providers: router.providerSummaries(), priority: router.priority() });
    });

    app.put('/api/v1/ai/providers/priority', (req, res) => {
      const parsed = providerOrderSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'La prioridad debe contener Gemini, Groq y Ollama una sola vez.' });
      database.prepare(`INSERT INTO ai_settings (key, value, updated_at) VALUES ('provider_priority', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(JSON.stringify(parsed.data.priority), now());
      res.json({ priority: router.priority() });
    });

    app.post('/api/v1/ai/providers/check', providerCheckLimiter, async (_req, res, next) => {
      try {
        const checks = await router.checkProviders();
        res.json({ providers: router.providerSummaries(), checks });
      } catch (error) {
        next(error);
      }
    });

    app.get('/api/v1/ai/generations', (req, res) => {
      const parsed = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: 'El límite del historial no es válido.' });
      const rows = database.prepare('SELECT * FROM ai_generations ORDER BY created_at DESC LIMIT ?').all(parsed.data.limit);
      res.json(rows.map((row) => publicGeneration(row, database)));
    });

    app.get('/api/v1/ai/generations/:id', (req, res) => {
      const row = database.prepare('SELECT * FROM ai_generations WHERE id = ?').get(req.params.id);
      if (!row) return res.status(404).json({ error: 'No se encontró la generación.' });
      res.json(publicGeneration(row, database));
    });

    app.post('/api/v1/ai/generations', generationLimiter, async (req, res) => {
      const parsed = generationInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Revisa la configuración de generación.', details: parsed.error.flatten() });
      }
      const idempotencyId = generationIdSchema.safeParse(req.get('idempotency-key'));
      if (!idempotencyId.success) {
        return res.status(400).json({ error: 'Se requiere un encabezado Idempotency-Key con un UUID válido.' });
      }
      const requestJson = JSON.stringify(parsed.data);
      const requestHash = createHash('sha256').update(requestJson).digest('hex');
      const existing = database.prepare('SELECT * FROM ai_generations WHERE id = ?').get(idempotencyId.data);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          return res.status(409).json({ error: 'El identificador de solicitud ya se usó con otra configuración.' });
        }
        if (existing.status === 'pending') {
          return res.status(202).json(publicGeneration(existing, database));
        }
        if (existing.status === 'failed') {
          return res.status(409).json({
            error: existing.error_message || 'La generación anterior terminó con error.',
            code: existing.error_code,
            generation: publicGeneration(existing, database),
          });
        }
        return res.json(publicGeneration(existing, database));
      }

      const generationId = idempotencyId.data;
      database.prepare(`INSERT INTO ai_generations (id, request_hash, request_json, status, created_at)
        VALUES (?, ?, ?, 'pending', ?)`).run(generationId, requestHash, requestJson, now());
      let generated;
      try {
        generated = await router.generate({ input: parsed.data, generationId });
      } catch (error) {
        const safe = safeProviderError(error);
        database.prepare(`UPDATE ai_generations SET status = 'failed', error_code = ?, error_message = ?,
          completed_at = ? WHERE id = ?`).run(safe.code, safe.message, now(), generationId);
        console.error(JSON.stringify({
          level: 'error',
          event: 'ai_generation_failed',
          generationId,
          errorCode: safe.code,
        }));
        const statusCode = safe.code === 'no_provider' ? 503 : error instanceof ProviderError ? 502 : 500;
        return res.status(statusCode).json({
          error: safe.message,
          code: safe.code,
          generation: publicGeneration(database.prepare('SELECT * FROM ai_generations WHERE id = ?').get(generationId), database),
        });
      }
      try {
        const completedAt = now();
        const resultJson = JSON.stringify(generated);
        database.prepare(`UPDATE ai_generations SET status = 'completed', result_json = ?, completed_at = ?
          WHERE id = ? AND status = 'pending'`).run(resultJson, completedAt, generationId);
        const row = database.prepare('SELECT * FROM ai_generations WHERE id = ?').get(generationId);
        return res.status(201).json(publicGeneration(row, database));
      } catch {
        database.prepare(`UPDATE ai_generations SET status = 'failed', error_code = 'persistence_error',
          error_message = 'El proveedor respondió, pero no se pudo persistir el resultado.', completed_at = ?
          WHERE id = ?`).run(now(), generationId);
        console.error(JSON.stringify({ level: 'error', event: 'ai_generation_persistence_failed', generationId }));
        return res.status(500).json({
          error: 'El proveedor respondió, pero no se pudo guardar el resultado. No se volverá a generar automáticamente.',
          code: 'persistence_error',
          generationId,
        });
      }
    });

    app.post('/api/v1/ai/generations/:id/save', (req, res) => {
      const parsed = saveVariantSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'El índice de variante no es válido.' });
      const generation = database.prepare('SELECT * FROM ai_generations WHERE id = ?').get(req.params.id);
      if (!generation) return res.status(404).json({ error: 'No se encontró la generación.' });
      if (generation.status !== 'completed' || !generation.result_json) {
        return res.status(409).json({ error: 'Solo se pueden guardar variantes de una generación completada.' });
      }
      const result = JSON.parse(generation.result_json);
      const variant = parsed.data.variant || result.variants[parsed.data.variantIndex];
      if (!variant) return res.status(404).json({ error: 'No se encontró esa variante.' });
      const transaction = database.transaction(() => {
        const state = database.prepare(`SELECT post_id, discarded_at FROM ai_generation_variants
          WHERE generation_id = ? AND variant_index = ?`).get(generation.id, parsed.data.variantIndex);
        if (state?.post_id) {
          return database.prepare('SELECT * FROM posts WHERE id = ?').get(state.post_id);
        }
        if (state?.discarded_at) throw new ProviderError('variant_discarded', 'La variante fue descartada y no se puede guardar.');
        const timestamp = now();
        const postId = randomUUID();
        result.variants[parsed.data.variantIndex] = variant;
        const hashtags = variant.hashtags.map((tag) => tag.startsWith('#') ? tag : `#${tag}`).join(' ');
        const body = [`Gancho: ${variant.hook}`, '', variant.script, '', `Descripción: ${variant.description}`].join('\n');
        database.prepare('UPDATE ai_generations SET result_json = ? WHERE id = ?')
          .run(JSON.stringify(result), generation.id);
        database.prepare(`INSERT INTO posts
          (id, title, platform, category, body, hashtags, source, status, scheduled_at, created_at, updated_at)
          VALUES (?, ?, 'TikTok', ?, ?, ?, ?, 'draft', NULL, ?, ?)`).run(
          postId,
          variant.title,
          generation.request_json ? JSON.parse(generation.request_json).category : 'Entretenimiento',
          body,
          hashtags,
          `Generado con ${result.provider} · ${result.model} · ${generation.id}`,
          timestamp,
          timestamp,
        );
        database.prepare(`INSERT INTO ai_generation_variants (generation_id, variant_index, post_id)
          VALUES (?, ?, ?) ON CONFLICT(generation_id, variant_index)
          DO UPDATE SET post_id = excluded.post_id, discarded_at = NULL`)
          .run(generation.id, parsed.data.variantIndex, postId);
        return database.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
      });
      try {
        const post = transaction();
        res.status(201).json({
          id: post.id, title: post.title, platform: post.platform, category: post.category,
          body: post.body, hashtags: post.hashtags, source: post.source, status: post.status,
          scheduledAt: post.scheduled_at, createdAt: post.created_at, updatedAt: post.updated_at,
        });
      } catch (error) {
        if (error instanceof ProviderError && error.code === 'variant_discarded') {
          return res.status(409).json({ error: error.message });
        }
        throw error;
      }
    });

    app.post('/api/v1/ai/generations/:id/discard', (req, res) => {
      const parsed = saveVariantSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'El índice de variante no es válido.' });
      const generation = database.prepare('SELECT status, result_json FROM ai_generations WHERE id = ?').get(req.params.id);
      if (!generation) return res.status(404).json({ error: 'No se encontró la generación.' });
      if (generation.status !== 'completed' || !generation.result_json) return res.status(409).json({ error: 'Solo puedes descartar variantes de una generación completada.' });
      const result = JSON.parse(generation.result_json);
      if (!result.variants[parsed.data.variantIndex]) return res.status(404).json({ error: 'No se encontró esa variante.' });
      const current = database.prepare(`SELECT post_id FROM ai_generation_variants
        WHERE generation_id = ? AND variant_index = ?`).get(req.params.id, parsed.data.variantIndex);
      if (current?.post_id) return res.status(409).json({ error: 'La variante ya se guardó como borrador.' });
      database.prepare(`INSERT INTO ai_generation_variants (generation_id, variant_index, discarded_at)
        VALUES (?, ?, ?) ON CONFLICT(generation_id, variant_index)
        DO UPDATE SET discarded_at = excluded.discarded_at`)
        .run(req.params.id, parsed.data.variantIndex, now());
      res.status(204).end();
    });
  }

  return { registerRoutes };
}
