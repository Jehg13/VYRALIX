import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertExternalOperationsEnabled } from '../automation/external-operations.js';

const SEARCH_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_CHARS = 18_000;
const researchInputSchema = z.object({
  niche: z.string().trim().min(2).max(80),
  audience: z.string().trim().min(2).max(120),
  market: z.string().trim().min(2).max(80),
  language: z.string().trim().min(2).max(40),
  goal: z.string().trim().min(2).max(100),
  format: z.string().trim().min(2).max(60),
  durationSeconds: z.number().int().min(15).max(180),
  confirmExternalSearch: z.literal(true),
});
const evidenceSchema = z.object({
  statement: z.string().trim().min(1).max(700),
  sourceIds: z.array(z.string().uuid()).max(12),
  evidenceLevel: z.enum(['reported', 'inference', 'needs_verification']),
}).superRefine((finding, context) => {
  if (finding.evidenceLevel === 'reported' && finding.sourceIds.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceIds'], message: 'Un hallazgo reportado necesita al menos una fuente.' });
  }
});
const searchResultSchema = z.object({
  summary: z.string().trim().min(1).max(2400),
  findings: z.array(z.object({
    statement: z.string().trim().min(1).max(700),
    sourceUrls: z.array(z.string().url()).max(12),
    evidenceLevel: z.enum(['reported', 'inference', 'needs_verification']),
  })).max(15),
  angles: z.array(z.object({
    title: z.string().trim().min(1).max(160),
    hook: z.string().trim().min(1).max(300),
    rationale: z.string().trim().min(1).max(600),
  })).max(10),
});
const proposalSchema = z.object({
  title: z.string().trim().min(1).max(160),
  centralIdea: z.string().trim().min(1).max(600),
  targetAudience: z.string().trim().min(1).max(200),
  hook: z.string().trim().min(1).max(400),
  narrativeDevelopment: z.string().trim().min(1).max(1800),
  durationSeconds: z.number().int().min(15).max(180),
  description: z.string().trim().min(1).max(500),
  hashtags: z.array(z.string().trim().regex(/^#[\p{L}\p{N}_]+$/u).max(60)).max(12),
  claims: z.array(evidenceSchema).max(15),
  scenes: z.array(z.object({
    order: z.number().int().min(1).max(12),
    durationSeconds: z.number().int().min(1).max(180),
    voiceover: z.string().trim().min(1).max(900),
    visualProposal: z.string().trim().min(1).max(500),
    sourceIds: z.array(z.string().uuid()).max(12),
  })).min(1).max(12),
}).superRefine((proposal, context) => {
  if (composeProposalScript(proposal).length > 5000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes'], message: 'El guion excede el límite de contenido compatible con Media Studio.' });
  }
});

function timestamp() {
  return new Date().toISOString();
}

function composeProposalScript(proposal) {
  return [
    `Idea central: ${proposal.centralIdea}`,
    `Hook: ${proposal.hook}`,
    `Desarrollo: ${proposal.narrativeDevelopment}`,
    `Descripción: ${proposal.description}`,
    ...proposal.scenes.map((scene) => `Escena ${scene.order} (${scene.durationSeconds}s): ${scene.voiceover}`),
  ].join('\n\n');
}

function serviceError(code, message, status = 400, details = {}) {
  return Object.assign(new Error(message), { code, status, ...details });
}

function retryAfterSeconds(response) {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const retryAt = Date.parse(value);
  return Number.isNaN(retryAt) ? null : Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

function parseJsonText(text, schema, label) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try {
    value = JSON.parse(cleaned);
  } catch {
    throw serviceError('response_invalid', `La respuesta de ${label} no tiene un formato válido.`, 502);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw serviceError('response_invalid', `La respuesta de ${label} está incompleta o contiene datos inválidos.`, 502);
  return parsed.data;
}

function interactionText(payload) {
  const blocks = [];
  const sources = [];
  const searchQueries = [];
  for (const step of Array.isArray(payload.steps) ? payload.steps : []) {
    if (step.type === 'google_search_call') {
      for (const query of Array.isArray(step.arguments?.queries) ? step.arguments.queries : []) {
        if (typeof query === 'string' && query.trim()) searchQueries.push(query.trim().slice(0, 500));
      }
    }
    if (step.type !== 'model_output' || !Array.isArray(step.content)) continue;
    for (const part of step.content) {
      if (part.type !== 'text' || typeof part.text !== 'string') continue;
      blocks.push(part.text);
      for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
        if (annotation.type === 'url_citation') sources.push({ ...annotation, answerText: part.text });
      }
    }
  }
  const text = blocks.join('\n').trim() || (typeof payload.output_text === 'string' ? payload.output_text.trim() : '');
  return { text, citations: sources, searchQueries: [...new Set(searchQueries)].slice(0, 20) };
}

function safeCitation(annotation, consultedAt) {
  let parsedUrl;
  try {
    parsedUrl = new URL(annotation.url);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) return null;
  const title = typeof annotation.title === 'string' ? annotation.title.trim().slice(0, 200) : '';
  const start = annotation.start_index;
  const end = annotation.end_index;
  const excerpt = Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start
    ? annotation.answerText.slice(start, Math.min(end, start + 1200)).trim().slice(0, 600)
    : '';
  return {
    id: randomUUID(),
    title: title || parsedUrl.hostname,
    url: parsedUrl.href,
    sourceName: parsedUrl.hostname,
    publishedAt: null,
    consultedAt,
    excerpt: excerpt || null,
    currentness: 'consulted_now',
  };
}

function searchPrompt(input) {
  return `Investiga con Google Search el tema indicado y responde ÚNICAMENTE con JSON válido, sin Markdown.
Usa solo información que aparezca respaldada por los resultados de búsqueda de esta solicitud. No inventes fuentes, URLs, fechas, estadísticas, tendencias virales ni datos de popularidad de TikTok.
Separa hechos reportados por fuentes, inferencias y afirmaciones que requieren verificación. Las ideas creativas deben etiquetarse como sugerencias, no como tendencias observadas.
Estructura exacta:
{"summary":"síntesis breve","findings":[{"statement":"afirmación concisa","sourceUrls":["URL exacta incluida en las citas de Google Search"],"evidenceLevel":"reported|inference|needs_verification"}],"angles":[{"title":"enfoque original","hook":"gancho propuesto","rationale":"por qué puede narrarse"}]}
En sourceUrls usa únicamente URLs exactas de las citas que Google Search adjuntó a esta respuesta; si no puedes asociar una fuente, usa []. No inventes URLs.
Tema/nicho: ${input.niche}
Audiencia: ${input.audience}
Mercado: ${input.market}
Idioma de respuesta: ${input.language}
Objetivo: ${input.goal}
Formato: ${input.format}
Duración prevista: ${input.durationSeconds} segundos.
Devuelve como máximo 10 hallazgos y 6 enfoques.`;
}

function proposalPrompt(record) {
  const result = record.result;
  return `Crea una propuesta original y editable de TikTok a partir de esta investigación. Devuelve únicamente JSON válido, sin Markdown.
No añadas afirmaciones actuales que no aparezcan en los hallazgos; marca cada afirmación como reported, inference o needs_verification. No inventes ni incluyas URLs. En cada afirmación factual usa únicamente sourceIds de la lista proporcionada; usa [] para ideas creativas o afirmaciones sin respaldo suficiente.
Los sourceIds deben copiarse exactamente de los datos de fuentes. La duración de la propuesta y la suma de escenas deben ser exactamente ${record.request.durationSeconds} segundos; conserva el orden 1..N.
Estructura exacta:
{"title":"...","centralIdea":"...","targetAudience":"...","hook":"...","narrativeDevelopment":"...","durationSeconds":30,"description":"...","hashtags":["#ejemplo"],"claims":[{"statement":"...","sourceIds":[],"evidenceLevel":"reported|inference|needs_verification"}],"scenes":[{"order":1,"durationSeconds":6,"voiceover":"...","visualProposal":"...","sourceIds":[]}]}
Solicitud original: ${JSON.stringify(record.request)}
Síntesis con fuentes verificadas:
${JSON.stringify({
    summary: result.summary,
    findings: result.findings,
    sources: result.sources.map(({ id, title, url, excerpt }) => ({ id, title, url, excerpt })),
  })}`;
}

function recordFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    request: JSON.parse(row.request_json),
    status: row.status,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    errorCode: row.error_code,
    provider: row.provider,
    model: row.model,
    proposal: row.proposal_json ? JSON.parse(row.proposal_json) : null,
    proposalStatus: row.proposal_status,
    proposalProvider: row.proposal_provider,
    proposalModel: row.proposal_model,
    mediaPostId: row.media_post_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateSourceIds(value, allowedIds) {
  const references = [
    ...value.claims.map((item) => item.sourceIds),
    ...value.scenes.map((item) => item.sourceIds),
  ];
  return references.every((ids) => ids.every((id) => allowedIds.has(id)));
}

export function createResearchService({
  database,
  aiRouter,
  fetchImpl = fetch,
  config = {
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || '',
    timeoutMs: Number(process.env.AI_PROVIDER_TIMEOUT_MS) || 45_000,
  },
}) {
  const pendingProposals = new Set();
  const getRow = database.prepare('SELECT * FROM research_sessions WHERE id = ?');

  function capabilities() {
    const ready = Boolean(config.geminiApiKey && config.geminiModel);
    return {
      configured: ready,
      provider: 'gemini',
      model: config.geminiModel || null,
      reason: ready ? null : 'Configura GEMINI_API_KEY y GEMINI_MODEL en el archivo .env local.',
      searchMethod: 'Google Search grounding (Gemini Interactions)',
      popularityDataAvailable: false,
    };
  }

  function list(limit = 20) {
    const boundedLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 20, 50));
    return database.prepare('SELECT * FROM research_sessions ORDER BY created_at DESC LIMIT ?')
      .all(boundedLimit).map(recordFromRow);
  }

  function get(id) {
    return recordFromRow(getRow.get(id));
  }

  async function performSearch(id, input, signal) {
    const controller = new AbortController();
    const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs >= 1000 && config.timeoutMs <= 120_000
      ? config.timeoutMs
      : SEARCH_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const abort = () => controller.abort(signal.reason || new Error('cancelled'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
        body: JSON.stringify({
          model: config.geminiModel,
          input: searchPrompt(input),
          tools: [{ type: 'google_search' }],
          store: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        const code = status === 429 ? 'rate_limited' : status === 401 ? 'authentication' : status === 403 ? 'permission_error' : 'search_provider_error';
        const message = status === 429
          ? 'Google Search alcanzó su límite. Espera antes de volver a investigar.'
          : status === 401 || status === 403
            ? 'Gemini no autorizó la búsqueda. Comprueba el acceso al modelo y Google Search en tu cuenta.'
            : 'Gemini no pudo completar la búsqueda. Inténtalo más tarde.';
        throw serviceError(code, message, status === 429 ? 429 : 502, {
          retryAfterSeconds: status === 429 ? retryAfterSeconds(response) : null,
        });
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw serviceError('search_response_invalid', 'Gemini devolvió una respuesta ilegible.', 502);
      }
      const { text, citations, searchQueries } = interactionText(payload);
      if (!text || text.length > MAX_RESPONSE_CHARS) throw serviceError('search_response_invalid', 'Gemini devolvió una respuesta vacía o demasiado extensa.', 502);
      if (searchQueries.length === 0) {
        throw serviceError('search_not_executed', 'Gemini no confirmó que Google Search ejecutara una consulta; no se guardó la respuesta como investigación actual.', 422);
      }
      const consultedAt = timestamp();
      const sourceByUrl = new Map();
      for (const citation of citations) {
        const source = safeCitation(citation, consultedAt);
        if (source && !sourceByUrl.has(source.url)) sourceByUrl.set(source.url, source);
      }
      if (sourceByUrl.size === 0) {
        throw serviceError('sources_missing', 'La búsqueda no devolvió citas web verificables; no se guardaron resultados como investigación actual.', 422);
      }
      const result = parseJsonText(text, searchResultSchema, 'Gemini Search');
      const sources = [...sourceByUrl.values()].slice(0, 20);
      const sourceIdsByUrl = new Map(sources.map((source) => [source.url, source.id]));
      result.findings = result.findings.map(({ sourceUrls, ...finding }) => {
        const sourceIds = sourceUrls.flatMap((url) => {
          try {
            const sourceId = sourceIdsByUrl.get(new URL(url).href);
            return sourceId ? [sourceId] : [];
          } catch {
            return [];
          }
        });
        return {
          ...finding,
          sourceIds: [...new Set(sourceIds)],
          evidenceLevel: finding.evidenceLevel === 'reported' && sourceIds.length === 0
            ? 'needs_verification'
            : finding.evidenceLevel,
        };
      });
      result.sources = sources;
      result.search = { executed: true, queries: searchQueries };
      result.popularity = {
        status: 'not_measured',
        note: 'No se consultaron métricas de popularidad ni tendencias internas de TikTok.',
      };
      const current = getRow.get(id);
      if (!current || current.status !== 'pending') return null;
      database.prepare(`UPDATE research_sessions SET status = 'completed', result_json = ?,
        model = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(result), config.geminiModel, timestamp(), id);
      return get(id);
    } catch (error) {
      const current = getRow.get(id);
      if (current?.status === 'pending') {
        const cancelled = signal?.aborted || controller.signal.aborted && controller.signal.reason?.message !== 'timeout';
        const code = error?.code || (controller.signal.aborted ? 'timeout' : 'search_provider_error');
        database.prepare(`UPDATE research_sessions SET status = ?, error_code = ?, updated_at = ? WHERE id = ?`)
          .run(cancelled ? 'cancelled' : 'failed', code, timestamp(), id);
        if (cancelled) return null;
      }
      if (error?.status) throw error;
      if (controller.signal.aborted) {
        throw serviceError('timeout', 'La búsqueda excedió el tiempo máximo permitido.', 504);
      }
      throw serviceError('search_provider_error', 'No se pudo conectar con Gemini Search. Revisa la conexión e inténtalo de nuevo.', 502);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function search(input, idempotencyKey, signal) {
    const parsed = researchInputSchema.safeParse(input);
    if (!parsed.success) throw serviceError('invalid_input', 'Completa los campos requeridos y confirma la búsqueda externa.');
    if (!capabilities().configured) throw serviceError('provider_unavailable', capabilities().reason, 503);
    if (typeof idempotencyKey !== 'string' || !z.string().uuid().safeParse(idempotencyKey).success) {
      throw serviceError('invalid_idempotency_key', 'La solicitud de investigación no tiene un identificador válido.');
    }
    const { confirmExternalSearch, ...searchRequest } = parsed.data;
    const requestJson = JSON.stringify(searchRequest);
    const requestHash = createHash('sha256').update(requestJson).digest('hex');
    const existing = database.prepare('SELECT * FROM research_sessions WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) {
      if (existing.request_hash !== requestHash) throw serviceError('idempotency_conflict', 'La clave de solicitud ya se utilizó con otra búsqueda.', 409);
      if (existing.status === 'pending') throw serviceError('request_pending', 'Esta búsqueda ya está en curso.', 409);
      return recordFromRow(existing);
    }
    assertExternalOperationsEnabled(database);
    const id = randomUUID();
    const createdAt = timestamp();
    database.prepare(`INSERT INTO research_sessions
      (id, idempotency_key, request_hash, request_json, status, provider, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', 'gemini', ?, ?, ?)`).run(
      id, idempotencyKey, requestHash, requestJson, config.geminiModel, createdAt, createdAt,
    );
    return performSearch(id, searchRequest, signal);
  }

  async function generateProposal(id, provider, confirmExternalCost, requestKey, signal) {
    const row = getRow.get(id);
    if (!row) throw serviceError('not_found', 'No se encontró la investigación.', 404);
    if (row.status !== 'completed' || !row.result_json) throw serviceError('research_incomplete', 'Completa una investigación con fuentes antes de crear una propuesta.', 409);
    if (!['gemini', 'groq', 'ollama'].includes(provider)) throw serviceError('invalid_provider', 'Selecciona un proveedor compatible.');
    if (provider !== 'ollama' && confirmExternalCost !== true) {
      throw serviceError('cost_confirmation_required', 'Confirma que autorizas una solicitud al proveedor externo antes de generar la propuesta.', 400);
    }
    if (typeof requestKey !== 'string' || !z.string().uuid().safeParse(requestKey).success) {
      throw serviceError('invalid_idempotency_key', 'La solicitud de propuesta no tiene un identificador válido.');
    }
    if (row.proposal_request_key === requestKey) {
      if (row.proposal_json) return recordFromRow(row);
      throw serviceError('request_pending', 'Esta generación de propuesta ya se solicitó; no se repetirá automáticamente.', 409);
    }
    if (pendingProposals.has(id)) throw serviceError('request_pending', 'Ya hay una propuesta en proceso para esta investigación.', 409);
    const record = recordFromRow(row);
    const validSourceIds = new Set(record.result.sources.map((source) => source.id));
    database.prepare('UPDATE research_sessions SET proposal_request_key = ?, updated_at = ? WHERE id = ?')
      .run(requestKey, timestamp(), id);
    pendingProposals.add(id);
    try {
      const response = await aiRouter.generateStructured({
        prompt: proposalPrompt(record),
        provider,
        task: 'research_proposal',
        signal,
        validateResponse: (text) => {
          const proposal = parseJsonText(text, proposalSchema, 'el proveedor seleccionado');
          if (!validateSourceIds(proposal, validSourceIds)) {
            throw serviceError('response_invalid', 'La propuesta incluyó referencias que no pertenecen a las fuentes recuperadas.', 502);
          }
          const sceneTotal = proposal.scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
          if (proposal.scenes.some((scene, index) => scene.order !== index + 1) ||
              sceneTotal !== record.request.durationSeconds ||
              proposal.durationSeconds !== record.request.durationSeconds) {
            throw serviceError('response_invalid', 'La duración u orden de escenas de la propuesta no coincide con lo solicitado.', 502);
          }
          return proposal;
        },
      });
      database.prepare(`UPDATE research_sessions SET proposal_json = ?, proposal_status = 'draft',
        proposal_provider = ?, proposal_model = ?, proposal_request_key = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(response.value), response.provider, response.model || null, requestKey, timestamp(), id);
      return get(id);
    } catch (error) {
      if (error?.code === 'cancelled' || signal?.aborted) throw serviceError('cancelled', 'La generación de propuesta fue cancelada.', 499);
      if (error?.status) throw error;
      throw serviceError(error?.code || 'proposal_generation_failed', error?.message || 'No se pudo generar la propuesta.', 502);
    } finally {
      pendingProposals.delete(id);
    }
  }

  async function regenerateSection(id, request, requestKey, signal) {
    const row = getRow.get(id);
    if (!row) throw serviceError('not_found', 'No se encontró la investigación.', 404);
    if (row.proposal_status !== 'draft' || !row.proposal_json) throw serviceError('proposal_locked', 'Solo se pueden regenerar secciones de una propuesta en borrador.', 409);
    const parsedRequest = z.object({
      provider: z.enum(['gemini', 'groq', 'ollama']),
      confirmExternalCost: z.boolean().default(false),
      section: z.enum(['hook', 'narrativeDevelopment', 'hashtags', 'sceneVoiceover']),
      sceneOrder: z.number().int().min(1).max(12).optional(),
    }).safeParse(request);
    if (!parsedRequest.success) throw serviceError('invalid_section', 'Selecciona una sección válida para regenerar.');
    const { provider, confirmExternalCost, section, sceneOrder } = parsedRequest.data;
    if (provider !== 'ollama' && confirmExternalCost !== true) {
      throw serviceError('cost_confirmation_required', 'Confirma que autorizas una solicitud al proveedor externo antes de regenerar.');
    }
    if (section === 'sceneVoiceover' && !sceneOrder) throw serviceError('invalid_section', 'Indica la escena que quieres regenerar.');
    if (typeof requestKey !== 'string' || !z.string().uuid().safeParse(requestKey).success) {
      throw serviceError('invalid_idempotency_key', 'La solicitud de regeneración no tiene un identificador válido.');
    }
    if (pendingProposals.has(id)) throw serviceError('request_pending', 'Ya hay una regeneración en proceso para esta investigación.', 409);
    if (row.proposal_request_key === requestKey) return recordFromRow(row);
    const record = recordFromRow(row);
    const sourceIds = new Set(record.result.sources.map((source) => source.id));
    const proposal = record.proposal;
    if (section === 'sceneVoiceover' && sceneOrder > proposal.scenes.length) {
      throw serviceError('invalid_section', 'La escena solicitada no existe.');
    }
    const currentValue = section === 'sceneVoiceover'
      ? proposal.scenes[sceneOrder - 1]
      : proposal[section];
    const outputSchema = section === 'hashtags'
      ? z.array(z.string().trim().regex(/^#[\p{L}\p{N}_]+$/u).max(60)).max(12)
      : z.string().trim().min(1).max(section === 'narrativeDevelopment' ? 1800 : 900);
    const prompt = `Regenera únicamente la sección "${section}" de esta propuesta. Devuelve solo JSON válido con la forma {"value": ...}.
Conserva el tema, audiencia, duración y hechos respaldados. No inventes datos ni URLs. Puedes usar sourceIds solo de las fuentes proporcionadas. La sección actual es: ${JSON.stringify(currentValue)}
Propuesta completa: ${JSON.stringify(proposal)}
Fuentes y hallazgos: ${JSON.stringify({
      findings: record.result.findings,
      sources: record.result.sources.map(({ id, title, url, excerpt }) => ({ id, title, url, excerpt })),
    })}
${section === 'sceneVoiceover' ? `Regenera solo la voz en off de la escena ${sceneOrder}; debe durar aproximadamente ${proposal.scenes[sceneOrder - 1].durationSeconds} segundos.` : ''}`;
    database.prepare('UPDATE research_sessions SET proposal_request_key = ?, updated_at = ? WHERE id = ?')
      .run(requestKey, timestamp(), id);
    pendingProposals.add(id);
    try {
      const response = await aiRouter.generateStructured({
        prompt,
        provider,
        task: 'research_proposal_section',
        signal,
        validateResponse: (text) => {
          const envelope = parseJsonText(text, z.object({ value: outputSchema }), 'el proveedor seleccionado');
          if (section === 'sceneVoiceover' && typeof envelope.value !== 'string') {
            throw serviceError('response_invalid', 'El proveedor no devolvió una voz en off válida.', 502);
          }
          return envelope.value;
        },
      });
      if (section === 'sceneVoiceover') {
        proposal.scenes[sceneOrder - 1] = { ...proposal.scenes[sceneOrder - 1], voiceover: response.value };
      } else {
        proposal[section] = response.value;
      }
      if (!validateSourceIds(proposal, sourceIds)) throw serviceError('response_invalid', 'La regeneración introdujo referencias de fuentes no válidas.', 502);
      database.prepare(`UPDATE research_sessions SET proposal_json = ?, proposal_provider = ?,
        proposal_model = ?, proposal_request_key = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(proposal), response.provider, response.model || null, requestKey, timestamp(), id);
      return get(id);
    } catch (error) {
      if (error?.code === 'cancelled' || signal?.aborted) throw serviceError('cancelled', 'La regeneración fue cancelada.', 499);
      if (error?.status) throw error;
      throw serviceError(error?.code || 'proposal_generation_failed', error?.message || 'No se pudo regenerar la sección.', 502);
    } finally {
      pendingProposals.delete(id);
    }
  }

  function updateProposal(id, proposal) {
    const row = getRow.get(id);
    if (!row) throw serviceError('not_found', 'No se encontró la investigación.', 404);
    if (row.proposal_status !== 'draft' || !row.proposal_json) throw serviceError('proposal_locked', 'Solo se pueden editar propuestas en borrador.', 409);
    const parsed = proposalSchema.safeParse(proposal);
    if (!parsed.success) throw serviceError('invalid_proposal', 'Revisa el contenido, el orden y la duración de la propuesta.');
    const record = recordFromRow(row);
    const validSourceIds = new Set(record.result.sources.map((source) => source.id));
    const sceneTotal = parsed.data.scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
    if (!validateSourceIds(parsed.data, validSourceIds) ||
        parsed.data.scenes.some((scene, index) => scene.order !== index + 1) ||
        sceneTotal !== record.request.durationSeconds ||
        parsed.data.durationSeconds !== record.request.durationSeconds) {
      throw serviceError('invalid_proposal', 'La propuesta contiene fuentes no verificadas, orden incorrecto o duración incompatible.');
    }
    database.prepare('UPDATE research_sessions SET proposal_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(parsed.data), timestamp(), id);
    return get(id);
  }

  function approveProposal(id) {
    const row = getRow.get(id);
    if (!row) throw serviceError('not_found', 'No se encontró la investigación.', 404);
    if (!row.proposal_json || row.proposal_status !== 'draft') throw serviceError('proposal_locked', 'Solo se puede aprobar una propuesta guardada en borrador.', 409);
    database.prepare(`UPDATE research_sessions SET proposal_status = 'approved', updated_at = ? WHERE id = ?`)
      .run(timestamp(), id);
    return get(id);
  }

  function sendToMedia(id) {
    const row = getRow.get(id);
    if (!row) throw serviceError('not_found', 'No se encontró la investigación.', 404);
    if (!row.proposal_json || !['approved', 'sent_to_media'].includes(row.proposal_status)) {
      throw serviceError('approval_required', 'Aprueba la propuesta antes de enviarla a Media Studio.', 409);
    }
    if (row.media_post_id) {
      const existing = database.prepare('SELECT * FROM posts WHERE id = ?').get(row.media_post_id);
      if (existing) return { record: get(id), post: existing, existing: true };
    }
    const proposal = JSON.parse(row.proposal_json);
    const body = composeProposalScript(proposal);
    const source = `Investigación VYRALIX ${id}`;
    const hashtags = proposal.hashtags.join(' ');
    const postId = randomUUID();
    const createdAt = timestamp();
    const transaction = database.transaction(() => {
      database.prepare(`INSERT INTO posts
        (id, title, platform, category, body, hashtags, source, status, scheduled_at, created_at, updated_at)
        VALUES (?, ?, 'TikTok', ?, ?, ?, ?, 'draft', NULL, ?, ?)`).run(
        postId, proposal.title, JSON.parse(row.request_json).niche,
        body, hashtags, source, createdAt, createdAt,
      );
      database.prepare(`UPDATE research_sessions SET proposal_status = 'sent_to_media',
        media_post_id = ?, updated_at = ? WHERE id = ?`).run(postId, createdAt, id);
    });
    transaction();
    return {
      record: get(id),
      post: database.prepare('SELECT * FROM posts WHERE id = ?').get(postId),
      existing: false,
    };
  }

  return {
    capabilities,
    list,
    get,
    search,
    generateProposal,
    regenerateSection,
    updateProposal,
    approveProposal,
    sendToMedia,
  };
}
