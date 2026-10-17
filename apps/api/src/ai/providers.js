import { ProviderError } from './provider-error.js';

const RESPONSE_LIMIT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_LIMIT) {
      await reader.cancel();
      throw new ProviderError('response_too_large', 'La respuesta del proveedor superó el límite permitido.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ProviderError('malformed_response', 'El proveedor devolvió una respuesta JSON inválida.');
  }
}

function retryAfter(response) {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}

function classifyStatus(response, payload) {
  const status = response.status;
  const providerMessage = payload?.error?.message || payload?.error || '';
  const providerCode = payload?.error?.status || payload?.error?.code || '';
  if (status === 429) {
    return new ProviderError('rate_limited', 'El proveedor indicó límite de solicitudes o cuota.', {
      retryable: true, retryAfterSeconds: retryAfter(response), status,
    });
  }
  if (/resource_exhausted|quota|rate.?limit/i.test(`${providerCode} ${providerMessage}`)) {
    return new ProviderError('rate_limited', 'El proveedor indicó límite de solicitudes o cuota.', {
      retryable: true, retryAfterSeconds: retryAfter(response), status,
    });
  }
  if (status === 401 || /api.?key.?invalid|unauthorized|invalid.?credential/i.test(`${providerCode} ${providerMessage}`)) {
    return new ProviderError('authentication', 'El proveedor rechazó las credenciales o los permisos.', { status });
  }
  if (status === 403 || /permission.?denied|insufficient.?permission/i.test(`${providerCode} ${providerMessage}`)) {
    return new ProviderError('permission_error', 'La cuenta no tiene permisos para esta operación.', { status });
  }
  if (status === 404) return new ProviderError('model_not_found', 'El modelo configurado no está disponible.', { status });
  if (status >= 500) {
    return new ProviderError('provider_temporary', 'El proveedor presentó un error temporal.', { retryable: true, status });
  }
  if (status >= 400) {
    const code = /model|not found/i.test(String(providerMessage)) ? 'model_not_found' : 'invalid_request';
    return new ProviderError(code, 'El proveedor rechazó la solicitud.', { status });
  }
  return null;
}

function transportError(error) {
  const codes = [];
  for (let current = error; current; current = current.cause) {
    if (typeof current.code === 'string') codes.push(current.code);
  }
  if (codes.some((code) => ['ENOTFOUND', 'EAI_AGAIN'].includes(code))) {
    return new ProviderError('dns', 'No se pudo resolver el host del proveedor.', { retryable: true });
  }
  if (codes.some((code) =>
    code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') ||
    ['CERT_HAS_EXPIRED', 'CERT_AUTHORITY_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(code))) {
    return new ProviderError('tls', 'No se pudo establecer una conexión TLS segura con el proveedor.');
  }
  return new ProviderError('connectivity', 'No se pudo conectar con el proveedor.', { retryable: true });
}

async function postJson(url, { headers, body, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch, signal }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const abortFromCaller = () => controller.abort(signal.reason || new Error('cancelled'));
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw new ProviderError('cancelled', 'La solicitud fue cancelada.');
      if (controller.signal.aborted) {
        throw new ProviderError('timeout', 'La solicitud excedió el tiempo máximo permitido.', { retryable: true });
      }
      throw transportError(error);
    }
    let payload;
    try {
      payload = await readJson(response);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (signal?.aborted) throw new ProviderError('cancelled', 'La solicitud fue cancelada.');
      if (controller.signal.aborted) {
        throw new ProviderError('response_timeout', 'El proveedor respondió, pero el contenido excedió el tiempo máximo de lectura.', {
          retryable: true, status: response.status,
        });
      }
      throw transportError(error);
    }
    if (!response.ok) throw classifyStatus(response, payload);
    return payload;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

async function getJson(url, { headers, timeoutMs = 8000, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, { headers, signal: controller.signal });
    } catch {
      if (controller.signal.aborted) throw new ProviderError('timeout', 'La comprobación excedió el tiempo máximo.');
      throw new ProviderError('connectivity', 'No se pudo conectar con el proveedor.');
    }
    const payload = await readJson(response);
    if (!response.ok) throw classifyStatus(response, payload);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function validateOllamaBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError('invalid_configuration', 'La URL base de Ollama no es válida.');
  }
  const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (url.protocol !== 'http:' || !localHosts.has(url.hostname) || url.username || url.password) {
    throw new ProviderError('invalid_configuration', 'Por seguridad, Ollama debe usar HTTP en loopback local sin credenciales en la URL.');
  }
  return url.origin;
}

export function createProviderDefinitions(config, fetchOptions = {}) {
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  let ollamaOrigin = null;
  let ollamaConfigurationError = null;
  try {
    ollamaOrigin = validateOllamaBase(config.ollamaBaseUrl || 'http://127.0.0.1:11434');
  } catch (error) {
    ollamaConfigurationError = error;
  }
  const gemini = {
    id: 'gemini',
    name: 'Google Gemini',
    model: config.geminiModel,
    configured: Boolean(config.geminiApiKey && config.geminiModel),
    missing: [!config.geminiApiKey && 'GEMINI_API_KEY', !config.geminiModel && 'GEMINI_MODEL'].filter(Boolean),
    capabilities: ['ideas', 'short_scripts', 'hashtags', 'structured_text'],
    autoFallbackAllowed: config.geminiAutoFallback === true,
    mayIncurCost: true,
    isPaid: false,
    async generate(prompt, { signal } = {}) {
      const key = config.geminiApiKey;
      const model = encodeURIComponent(config.geminiModel);
      const payload = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          headers: { 'x-goog-api-key': key },
          body: {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.85, maxOutputTokens: 8192 },
          },
          ...fetchOptions,
          timeoutMs,
          signal,
        },
      );
      const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('');
      if (!text) throw new ProviderError('incompatible_response', 'Gemini no devolvió contenido de texto.');
      return { text, usage: payload.usageMetadata ? { inputTokens: payload.usageMetadata.promptTokenCount, outputTokens: payload.usageMetadata.candidatesTokenCount } : null };
    },
    async check() {
      const payload = await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
        headers: { 'x-goog-api-key': config.geminiApiKey },
        ...fetchOptions,
      });
      const models = (payload.models || [])
        .filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
        .map((model) => model.name?.replace(/^models\//, ''))
        .filter(Boolean);
      return { available: models.includes(config.geminiModel), modelValid: models.includes(config.geminiModel), models: models.slice(0, 100) };
    },
  };
  const groq = {
    id: 'groq',
    name: 'Groq',
    model: config.groqModel,
    configured: Boolean(config.groqApiKey && config.groqModel),
    missing: [!config.groqApiKey && 'GROQ_API_KEY', !config.groqModel && 'GROQ_MODEL'].filter(Boolean),
    capabilities: ['ideas', 'short_scripts', 'hashtags', 'structured_text'],
    autoFallbackAllowed: config.groqAutoFallback === true,
    mayIncurCost: true,
    isPaid: false,
    async generate(prompt, { signal } = {}) {
      const payload = await postJson('https://api.groq.com/openai/v1/chat/completions', {
        headers: { Authorization: `Bearer ${config.groqApiKey}` },
        body: {
          model: config.groqModel,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.85,
          max_tokens: 8192,
        },
        ...fetchOptions,
        timeoutMs,
        signal,
      });
      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text) throw new ProviderError('incompatible_response', 'Groq no devolvió contenido de texto.');
      return { text, usage: payload.usage ? { inputTokens: payload.usage.prompt_tokens, outputTokens: payload.usage.completion_tokens } : null };
    },
    async check() {
      const payload = await getJson('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${config.groqApiKey}` },
        ...fetchOptions,
      });
      const models = (payload.data || []).map((model) => model.id).filter(Boolean);
      return { available: models.includes(config.groqModel), modelValid: models.includes(config.groqModel), models: models.slice(0, 100) };
    },
  };
  const ollama = {
    id: 'ollama',
    name: 'Ollama local',
    model: config.ollamaModel,
    configured: Boolean(config.ollamaModel && ollamaOrigin),
    missing: [!config.ollamaModel && 'OLLAMA_MODEL', ollamaConfigurationError && 'OLLAMA_BASE_URL'].filter(Boolean),
    configurationError: ollamaConfigurationError,
    capabilities: ['ideas', 'short_scripts', 'hashtags', 'structured_text'],
    autoFallbackAllowed: true,
    mayIncurCost: false,
    isPaid: false,
    async generate(prompt, { signal } = {}) {
      if (!ollamaOrigin) throw ollamaConfigurationError;
      const payload = await postJson(`${ollamaOrigin}/api/generate`, {
        body: { model: config.ollamaModel, prompt, format: 'json', stream: false },
        ...fetchOptions,
        timeoutMs,
        signal,
      });
      if (typeof payload.response !== 'string' || !payload.response) throw new ProviderError('incompatible_response', 'Ollama no devolvió contenido de texto.');
      return {
        text: payload.response,
        usage: Number.isFinite(payload.prompt_eval_count) || Number.isFinite(payload.eval_count)
          ? { inputTokens: payload.prompt_eval_count ?? null, outputTokens: payload.eval_count ?? null }
          : null,
      };
    },
    async check() {
      if (!ollamaOrigin) throw ollamaConfigurationError;
      const payload = await getJson(`${ollamaOrigin}/api/tags`, fetchOptions);
      const models = (payload.models || []).map((model) => model.name).filter(Boolean);
      return { available: models.includes(config.ollamaModel), modelValid: models.includes(config.ollamaModel), models: models.slice(0, 100) };
    },
  };
  return [gemini, groq, ollama];
}
