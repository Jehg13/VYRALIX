import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isValidPng } from './image-validation.js';

const models = [
  { id: 'gemini-nano-banana-2.1', name: 'Nano Banana 2.1 · recomendado' },
  { id: 'gemini-3.1-flash-lite-image', name: 'Nano Banana 2 Lite · menor costo' },
  { id: 'gemini-3.1-flash-image', name: 'Nano Banana 2' },
  { id: 'gemini-3-pro-image', name: 'Nano Banana Pro · premium' },
  { id: 'gemini-2.5-flash-image', name: 'Nano Banana · legado' },
];
const modelIds = new Set(models.map(({ id }) => id));
const requestSchema = z.object({
  provider: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(5).max(2000),
  confirmCost: z.literal(true),
}).strict();
const generationIdSchema = z.string().uuid();
const MAX_IMAGE_BYTES = 18 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

function publicError(status, response) {
  let retryAfterSeconds = null;
  if (status === 429) {
    const value = response.headers.get('retry-after');
    const seconds = Number(value);
    const date = Date.parse(value || '');
    if (value && Number.isFinite(seconds)) retryAfterSeconds = Math.max(0, Math.ceil(seconds));
    else if (value && !Number.isNaN(date)) retryAfterSeconds = Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  if (status === 401) return { status: 502, code: 'authentication', message: 'Google rechazó las credenciales.' };
  if (status === 403) return { status: 502, code: 'permission_error', message: 'La cuenta no tiene permisos para este modelo o función.' };
  if (status === 404) return { status: 502, code: 'model_not_found', message: 'El modelo de imágenes configurado no está disponible para esta cuenta.' };
  if (status === 429) return { status: 429, code: 'rate_limited', message: 'Google indicó un límite o cuota agotada. Comprueba el estado de facturación y los límites de tu cuenta.', retryAfterSeconds };
  if (status >= 500) return { status: 502, code: 'provider_temporary', message: 'Google presentó un error temporal. Inténtalo más tarde.' };
  return { status: 502, code: 'provider_error', message: 'Google rechazó la solicitud de generación. Revisa el prompt y la configuración del modelo.' };
}

async function readProviderJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw Object.assign(new Error('Google devolvió una respuesta vacía.'), { code: 'invalid_response' });
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw Object.assign(new Error('La respuesta de imagen excedió el límite permitido.'), { code: 'response_too_large' });
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Google devolvió una respuesta inválida.'), { code: 'invalid_response' });
  }
}

function decodeGeneratedImage(payload) {
  const image = payload?.output_image;
  if (typeof image?.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) ||
    image.data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3)) {
    throw Object.assign(new Error('Google no devolvió una imagen válida.'), { code: 'invalid_image' });
  }
  const buffer = Buffer.from(image.data, 'base64');
  if (!isValidPng(buffer) || (image.mime_type && image.mime_type !== 'image/png')) {
    throw Object.assign(new Error('La respuesta no contiene un PNG válido compatible con la biblioteca.'), { code: 'invalid_image' });
  }
  return buffer;
}

function createGeminiImageProvider({ apiKey, model, fetchImpl, timeoutMs }) {
  const supportedModel = modelIds.has(model);
  return {
    id: 'gemini',
    name: 'Gemini · Google',
    model: supportedModel ? model : null,
    models,
    configured: Boolean(apiKey && supportedModel),
    missing: [
      !apiKey && 'GEMINI_API_KEY',
      !model && 'GEMINI_IMAGE_MODEL',
      model && !supportedModel && 'GEMINI_IMAGE_MODEL (modelo de imagen compatible)',
    ].filter(Boolean),
    mayIncurCost: true,
    async generate(prompt, { signal } = {}) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      const abortFromCaller = () => controller.abort(signal.reason || new Error('cancelled'));
      if (signal?.aborted) abortFromCaller();
      else signal?.addEventListener('abort', abortFromCaller, { once: true });
      try {
        const response = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/interactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            model,
            input: [{ type: 'text', text: prompt }],
            store: false,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = publicError(response.status, response);
          throw Object.assign(new Error(error.message), {
            status: error.status, code: error.code, retryAfterSeconds: error.retryAfterSeconds,
          });
        }
        return { buffer: decodeGeneratedImage(await readProviderJson(response)), model };
      } catch (error) {
        if (controller.signal.aborted) {
          throw Object.assign(new Error(controller.signal.reason?.message === 'timeout'
            ? 'La solicitud a Google superó el tiempo máximo.'
            : 'La generación fue cancelada.'), {
            status: controller.signal.reason?.message === 'timeout' ? 504 : 499,
            code: controller.signal.reason?.message === 'timeout' ? 'timeout' : 'cancelled',
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abortFromCaller);
      }
    },
  };
}

export function createImageGenerationService({
  mediaService,
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_IMAGE_MODEL,
  fetchImpl = fetch,
  timeoutMs = 120_000,
  clock = Date.now,
  providers,
  assertExternalOperationsEnabled = () => {},
} = {}) {
  const previews = new Map();
  const pending = new Map();
  const imageProviders = providers || [createGeminiImageProvider({ apiKey, model, fetchImpl, timeoutMs })];
  const providersById = new Map(imageProviders.map((provider) => [provider.id, provider]));
  const gemini = providersById.get('gemini');
  const settings = () => ({
    provider: 'gemini',
    enabled: Boolean(gemini?.configured),
    model: gemini?.model || null,
    availableModels: gemini?.model ? gemini.models.filter((item) => item.id === gemini.model) : (gemini?.models || models),
    missing: gemini?.missing || ['GEMINI_API_KEY', 'GEMINI_IMAGE_MODEL'],
    mayIncurCost: gemini?.mayIncurCost ?? true,
  });

  function getPreview(id) {
    const item = previews.get(id);
    if (!item || item.expiresAt <= clock()) {
      previews.delete(id);
      return null;
    }
    return item;
  }

  async function generate(body, requestId, signal) {
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      throw Object.assign(new Error('Indica Gemini, un modelo de imagen compatible, un prompt de 5 a 2000 caracteres y confirma el posible costo.'), {
        status: 400, code: 'invalid_request',
      });
    }
    const provider = providersById.get(parsed.data.provider);
    if (!provider) {
      throw Object.assign(new Error('El proveedor de imágenes seleccionado no está disponible.'), {
        status: 400, code: 'unsupported_provider',
      });
    }
    if (!provider.configured) {
      const message = provider.id === 'gemini'
        ? 'Configura GEMINI_API_KEY y un GEMINI_IMAGE_MODEL compatible antes de generar.'
        : 'Configura las credenciales y el modelo de imágenes del proveedor seleccionado.';
      throw Object.assign(new Error(message), {
        status: 503, code: 'not_configured',
      });
    }
    if (!provider.models.some((item) => item.id === parsed.data.model)) {
      throw Object.assign(new Error('El modelo no está documentado como compatible con generación de imágenes.'), {
        status: 400, code: 'unsupported_model',
      });
    }
    if (parsed.data.model !== provider.model) {
      throw Object.assign(new Error('El modelo solicitado no coincide con el modelo de imagen configurado en el servidor.'), {
        status: 409, code: 'model_mismatch',
      });
    }
    const requestHash = createHash('sha256').update(JSON.stringify({
      provider: parsed.data.provider,
      model: parsed.data.model,
      prompt: parsed.data.prompt,
    })).digest('hex');
    const existing = getPreview(requestId);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw Object.assign(new Error('El identificador de solicitud ya se usó con otra configuración.'), {
          status: 409, code: 'idempotency_conflict',
        });
      }
      return { id: requestId, model, contentUrl: `/media/image-generations/${requestId}/content` };
    }
    assertExternalOperationsEnabled({
      provider: provider.id,
      model: parsed.data.model,
      prompt: parsed.data.prompt,
      requestId,
    });
    const current = pending.get(requestId);
    if (current) {
      if (current.requestHash !== requestHash) {
        throw Object.assign(new Error('El identificador de solicitud ya se usó con otra configuración.'), {
          status: 409, code: 'idempotency_conflict',
        });
      }
      return current.promise;
    }

    const promise = (async () => {
      try {
        const generated = await provider.generate(parsed.data.prompt, { signal });
        if (!isValidPng(generated.buffer)) {
          throw Object.assign(new Error('La respuesta no contiene un PNG válido compatible con la biblioteca.'), { code: 'invalid_image' });
        }
        previews.set(requestId, {
          buffer: generated.buffer,
          providerId: provider.id,
          providerName: provider.name,
          model: generated.model,
          requestHash,
          expiresAt: clock() + 30 * 60_000,
          savedAsset: null,
        });
        while (previews.size > 20) previews.delete(previews.keys().next().value);
        return { id: requestId, provider: provider.id, model: generated.model, contentUrl: `/media/image-generations/${requestId}/content` };
      } finally {
        pending.delete(requestId);
      }
    })();
    pending.set(requestId, { requestHash, promise });
    return promise;
  }

  function registerRoutes(app, limiter = (_req, _res, next) => next()) {
    app.get('/api/v1/media/image-generations/capabilities', (_req, res) => res.json(settings()));
    app.post('/api/v1/media/image-generations', limiter, async (req, res) => {
      const id = generationIdSchema.safeParse(req.get('idempotency-key'));
      if (!id.success) return res.status(400).json({ error: 'Se requiere Idempotency-Key con un UUID válido.' });
      const controller = new AbortController();
      const abort = () => controller.abort(new Error('cancelled'));
      req.once('aborted', abort);
      res.once('close', () => {
        if (!res.writableEnded) abort();
      });
      try {
        const result = await generate(req.body, id.data, controller.signal);
        return res.status(201).json(result);
      } catch (error) {
        if (res.destroyed || res.headersSent) return;
        return res.status(error.status || 502).json({
          error: error.message || 'No se pudo completar la generación.',
          code: error.code || 'provider_error',
        });
      }
    });
    app.get('/api/v1/media/image-generations/:id/content', (req, res) => {
      if (!generationIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de previsualización inválido.' });
      const preview = getPreview(req.params.id);
      if (!preview) return res.status(404).json({ error: 'La previsualización caducó o ya no está disponible. Genera otra imagen.' });
      res.type('image/png');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'no-store');
      return res.send(preview.buffer);
    });
    app.post('/api/v1/media/image-generations/:id/save', async (req, res) => {
      if (!generationIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de previsualización inválido.' });
      const preview = getPreview(req.params.id);
      if (!preview) return res.status(404).json({ error: 'La previsualización caducó o ya no está disponible. Genera otra imagen.' });
      if (preview.savedAsset) return res.json({ ...preview.savedAsset, duplicate: true });
      if (preview.saving) {
        try {
          const saved = await preview.saving;
          return res.json({ ...saved, duplicate: true });
        } catch (error) {
          return res.status(error.status || 500).json({ error: error.message || 'No se pudo guardar la imagen en la biblioteca.' });
        }
      }
      preview.saving = mediaService.saveGeneratedImage(preview.buffer, preview.providerName, preview.model);
      try {
        const saved = await preview.saving;
        preview.savedAsset = saved;
        return res.status(saved.duplicate ? 200 : 201).json(saved);
      } catch (error) {
        delete preview.saving;
        return res.status(error.status || 500).json({ error: error.message || 'No se pudo guardar la imagen en la biblioteca.' });
      }
    });
  }

  return { registerRoutes, generate, settings, getPreview };
}
