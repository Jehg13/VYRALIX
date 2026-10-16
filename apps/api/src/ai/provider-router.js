import { randomUUID } from 'node:crypto';
import { db as defaultDb } from '../db.js';
import { ProviderError, safeProviderError } from './provider-error.js';
import { createProviderDefinitions } from './providers.js';
import { buildPrompt, parseGeneratedText } from './schema.js';

const DEFAULT_PRIORITY = ['gemini', 'groq', 'ollama'];
const RETRIES = 1;

function envConfig(env) {
  const timeoutMs = Number(env.AI_PROVIDER_TIMEOUT_MS || 45_000);
  return {
    geminiApiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || '',
    geminiAutoFallback: env.GEMINI_AUTO_FALLBACK === 'true',
    groqApiKey: env.GROQ_API_KEY || '',
    groqModel: env.GROQ_MODEL || '',
    groqAutoFallback: env.GROQ_AUTO_FALLBACK === 'true',
    ollamaBaseUrl: env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
    ollamaModel: env.OLLAMA_MODEL || '',
    timeoutMs: Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 120_000 ? timeoutMs : 45_000,
  };
}

function timestamp() {
  return new Date().toISOString();
}

function savedPriority(database) {
  const saved = database.prepare("SELECT value FROM ai_settings WHERE key = 'provider_priority'").get();
  if (saved) {
    try {
      const order = JSON.parse(saved.value);
      if (Array.isArray(order) && DEFAULT_PRIORITY.every((provider) => order.includes(provider)) && order.length === DEFAULT_PRIORITY.length) {
        return order;
      }
    } catch {
      console.error(JSON.stringify({ level: 'error', event: 'invalid_ai_provider_priority' }));
    }
  }
  const fromEnv = (process.env.AI_PROVIDER_PRIORITY || '').split(',').map((item) => item.trim()).filter(Boolean);
  return fromEnv.length === 3 && DEFAULT_PRIORITY.every((provider) => fromEnv.includes(provider))
    ? fromEnv
    : DEFAULT_PRIORITY;
}

export function createProviderRouter({
  database = defaultDb,
  config = envConfig(process.env),
  providers = createProviderDefinitions(config),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = Date.now,
} = {}) {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));

  function priority() {
    return savedPriority(database);
  }

  function recordAttempt(attempt) {
    database.prepare(`INSERT INTO ai_provider_attempts (
      id, generation_id, provider, model, task, outcome, error_code, duration_ms,
      attempt, fallback_reason, retry_after_seconds, input_tokens, output_tokens,
      cost_amount, cost_kind, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'unknown', ?)`).run(
      randomUUID(),
      attempt.generationId ?? null,
      attempt.provider,
      attempt.model || null,
      attempt.task,
      attempt.outcome,
      attempt.errorCode || null,
      attempt.durationMs,
      attempt.attempt,
      attempt.fallbackReason || null,
      attempt.retryAfterSeconds ?? null,
      attempt.usage?.inputTokens ?? null,
      attempt.usage?.outputTokens ?? null,
      timestamp(),
    );
  }

  function providerSummaries() {
    const ordering = priority();
    return ordering.map((id, index) => {
      const provider = byId.get(id);
      const state = database.prepare('SELECT * FROM ai_provider_state WHERE provider = ?').get(id);
      const latestGeneration = database.prepare(`SELECT * FROM ai_provider_attempts
        WHERE provider = ? AND task = 'generation' ORDER BY created_at DESC LIMIT 1`).get(id);
      const latestError = database.prepare(`SELECT error_code FROM ai_provider_attempts
        WHERE provider = ? AND outcome = 'failed' ORDER BY created_at DESC LIMIT 1`).get(id);
      return {
        id,
        name: provider.name,
        model: provider.model || null,
        configured: provider.configured,
        missing: provider.missing,
        capabilities: provider.capabilities,
        priority: index + 1,
        mayIncurCost: provider.mayIncurCost,
        autoFallbackAllowed: provider.autoFallbackAllowed,
        availability: state?.availability || 'unknown',
        checkedAt: state?.checked_at || null,
        availableModels: state ? JSON.parse(state.models_json) : [],
        lastError: latestError?.error_code || null,
        lastRunAt: latestGeneration?.created_at || null,
        isPaid: provider.isPaid,
      };
    });
  }

  async function checkProviders() {
    const results = [];
    for (const provider of byId.values()) {
      if (!provider.configured) {
        database.prepare(`INSERT INTO ai_provider_state (provider, availability, models_json, checked_at, error_code)
          VALUES (?, 'unknown', '[]', ?, NULL)
          ON CONFLICT(provider) DO UPDATE SET availability = 'unknown', models_json = '[]', checked_at = excluded.checked_at, error_code = NULL`)
          .run(provider.id, timestamp());
        results.push({ id: provider.id, availability: 'unknown', errorCode: null });
        continue;
      }
      const started = clock();
      try {
        const check = await provider.check();
        const availability = check.modelValid ? 'available' : 'model_invalid';
        const checkedAt = timestamp();
        database.prepare(`INSERT INTO ai_provider_state (provider, availability, models_json, checked_at, error_code)
          VALUES (?, ?, ?, ?, NULL)
          ON CONFLICT(provider) DO UPDATE SET availability = excluded.availability, models_json = excluded.models_json,
          checked_at = excluded.checked_at, error_code = NULL`)
          .run(provider.id, availability, JSON.stringify(check.models || []), checkedAt);
        recordAttempt({
          provider: provider.id, model: provider.model, task: 'availability', outcome: 'success',
          durationMs: Math.max(0, clock() - started), attempt: 1,
        });
        results.push({ id: provider.id, availability, errorCode: null });
      } catch (error) {
        const safe = safeProviderError(error);
        const checkedAt = timestamp();
        database.prepare(`INSERT INTO ai_provider_state (provider, availability, models_json, checked_at, error_code)
          VALUES (?, 'unavailable', '[]', ?, ?)
          ON CONFLICT(provider) DO UPDATE SET availability = 'unavailable', models_json = '[]',
          checked_at = excluded.checked_at, error_code = excluded.error_code`)
          .run(provider.id, checkedAt, safe.code);
        recordAttempt({
          provider: provider.id, model: provider.model, task: 'availability', outcome: 'failed',
          errorCode: safe.code, durationMs: Math.max(0, clock() - started), attempt: 1,
        });
        results.push({ id: provider.id, availability: 'unavailable', errorCode: safe.code });
      }
    }
    return results;
  }

  async function generate({ input, generationId }) {
    const order = input.provider === 'auto' ? priority() : [input.provider];
    const available = order.map((id) => byId.get(id)).filter((provider) => provider?.configured);
    const candidates = input.provider === 'auto'
      ? available.filter((provider, index) => index === 0 || provider.autoFallbackAllowed === true)
      : available;
    if (!candidates.length) {
      throw new ProviderError('no_provider', input.provider === 'auto'
        ? 'No hay proveedores gratuitos/locales configurados. Configura un proveedor y modelo en .env.'
        : `El proveedor ${input.provider} no está configurado con credenciales y modelo.`);
    }
    const prompt = buildPrompt(input);
    const failures = [];
    let totalAttempt = 0;
    for (let providerIndex = 0; providerIndex < candidates.length; providerIndex += 1) {
      const provider = candidates[providerIndex];
      const maxAttempts = RETRIES + 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        totalAttempt += 1;
        const started = clock();
        try {
          const response = await provider.generate(prompt);
          let result;
          try {
            result = parseGeneratedText(response.text, input.variants);
          } catch {
            throw new ProviderError('response_invalid', 'La respuesta del proveedor no cumple el formato de contenido requerido.');
          }
          const usage = response.usage || null;
          recordAttempt({
            generationId,
            provider: provider.id,
            model: provider.model,
            task: 'generation',
            outcome: 'success',
            durationMs: Math.max(0, clock() - started),
            attempt: totalAttempt,
            fallbackReason: failures.length ? failures.at(-1).code : null,
            usage,
          });
          return {
            ...result,
            provider: provider.id,
            model: provider.model,
            attempts: totalAttempt,
            usage,
            fallbackReason: failures.length ? failures.at(-1).code : null,
          };
        } catch (error) {
          const safe = safeProviderError(error);
          const retryAfterSeconds = error instanceof ProviderError ? error.retryAfterSeconds : null;
          const retrying = safe.retryable && safe.code !== 'rate_limited' && attempt < maxAttempts;
          recordAttempt({
            generationId,
            provider: provider.id,
            model: provider.model,
            task: 'generation',
            outcome: 'failed',
            errorCode: safe.code,
            durationMs: Math.max(0, clock() - started),
            attempt: totalAttempt,
            fallbackReason: retrying ? 'retrying_transient_error' : (failures.at(-1)?.code || null),
            retryAfterSeconds,
          });
          failures.push({ provider: provider.id, code: safe.code, retryAfterSeconds });
          if (retrying) {
            await sleep(Math.min(250 * (2 ** (attempt - 1)), 2000));
            continue;
          }
          break;
        }
      }
    }
    const finalFailure = failures.at(-1);
    const error = new ProviderError(
      finalFailure?.code || 'no_provider',
      finalFailure?.retryAfterSeconds != null
        ? `Los proveedores no pudieron atender la solicitud. El proveedor limitado indicó Retry-After de ${finalFailure.retryAfterSeconds} segundos.`
        : 'Ningún proveedor compatible pudo completar la generación. Revisa su configuración y vuelve a intentarlo.',
    );
    error.failures = failures;
    throw error;
  }

  async function generateStructured({
    prompt,
    provider: providerId = 'auto',
    task = 'media_planning',
    signal,
    validateResponse = (text) => text,
  }) {
    const order = providerId === 'auto' ? priority() : [providerId];
    const available = order.map((id) => byId.get(id)).filter((provider) => provider?.configured);
    const candidates = providerId === 'auto'
      ? available.filter((provider, index) => index === 0 || provider.autoFallbackAllowed === true)
      : available;
    if (!candidates.length) {
      throw new ProviderError('no_provider', providerId === 'auto'
        ? 'No hay proveedores configurados. Elige un proveedor habilitado en Configuración.'
        : `El proveedor ${providerId} no está configurado con credenciales y modelo.`);
    }
    const failures = [];
    let totalAttempt = 0;
    for (const provider of candidates) {
      for (let attempt = 1; attempt <= RETRIES + 1; attempt += 1) {
        if (signal?.aborted) throw new ProviderError('cancelled', 'La solicitud fue cancelada.');
        totalAttempt += 1;
        const started = clock();
        let currentPrompt = prompt;
        if (attempt > 1 && failures.at(-1)?.code === 'response_invalid') {
          currentPrompt = `${prompt}\n\nLa respuesta anterior no cumplió el esquema. Reintenta una sola vez; devuelve únicamente un objeto JSON completo que cumpla exactamente la estructura solicitada.`;
        }
        try {
          const response = await provider.generate(currentPrompt, { signal });
          const value = validateResponse(response.text);
          const usage = response.usage || null;
          recordAttempt({
            provider: provider.id,
            model: provider.model,
            task,
            outcome: 'success',
            durationMs: Math.max(0, clock() - started),
            attempt: totalAttempt,
            fallbackReason: failures.length ? failures.at(-1).code : null,
            usage,
          });
          return {
            value,
            provider: provider.id,
            model: provider.model,
            attempts: totalAttempt,
            usage,
            fallbackReason: failures.length ? failures.at(-1).code : null,
          };
        } catch (error) {
          if (signal?.aborted || error?.code === 'cancelled') {
            throw new ProviderError('cancelled', 'La solicitud fue cancelada.');
          }
          const safe = safeProviderError(error);
          const retryAfterSeconds = error instanceof ProviderError ? error.retryAfterSeconds : null;
          const retrying = (safe.retryable || safe.code === 'response_invalid') && attempt < RETRIES + 1;
          recordAttempt({
            provider: provider.id,
            model: provider.model,
            task,
            outcome: 'failed',
            errorCode: safe.code,
            durationMs: Math.max(0, clock() - started),
            attempt: totalAttempt,
            fallbackReason: retrying ? 'retrying_structured_response' : (failures.at(-1)?.code || null),
            retryAfterSeconds,
          });
          failures.push({ provider: provider.id, code: safe.code, retryAfterSeconds });
          if (retrying) {
            if (safe.code !== 'response_invalid') await sleep(Math.min(250 * (2 ** (attempt - 1)), 2000));
            continue;
          }
          break;
        }
      }
    }
    const finalFailure = failures.at(-1);
    const error = new ProviderError(
      finalFailure?.code || 'no_provider',
      finalFailure?.code === 'response_invalid'
        ? 'El proveedor devolvió una respuesta incompleta o inválida incluso después de un reintento. El proyecto no se modificó.'
        : 'Ningún proveedor compatible pudo completar la planificación. Revisa su configuración y vuelve a intentarlo.',
    );
    error.failures = failures;
    throw error;
  }

  function getHistory(id) {
    const row = id
      ? database.prepare('SELECT * FROM ai_generations WHERE id = ?').get(id)
      : null;
    return row;
  }

  return { generate, generateStructured, priority, providerSummaries, checkProviders, recordAttempt, getHistory };
}
