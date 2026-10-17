import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const uuidSchema = z.string().uuid();
const researchInput = z.object({
  niche: z.string().trim().min(2).max(80),
  audience: z.string().trim().min(2).max(120),
  market: z.string().trim().min(2).max(80),
  language: z.string().trim().min(2).max(40),
  goal: z.string().trim().min(2).max(100),
  format: z.string().trim().min(2).max(60),
  durationSeconds: z.number().int().min(15).max(180),
}).strict();
const taskSchemas = {
  research: z.object({ type: z.literal('research'), input: researchInput }).strict(),
  proposal: z.object({
    type: z.literal('proposal'),
    researchId: uuidSchema,
    provider: z.enum(['gemini', 'groq', 'ollama']),
  }).strict(),
  image_generation: z.object({
    type: z.literal('image_generation'),
    provider: z.literal('gemini'),
    model: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(5).max(2000),
  }).strict(),
  media_preflight: z.object({ type: z.literal('media_preflight') }).strict(),
};
const externalConsentFields = {
  research: (params) => params?.input?.confirmExternalSearch === true,
  proposal: (params) => params?.confirmExternalCost === true,
  image_generation: (params) => params?.confirmCost === true,
};
const publicSelect = `SELECT id, idempotency_key, request_hash, type, status, stage, result_json,
  error_code, provider, model, is_external, attempts, max_attempts, last_attempt_at,
  next_attempt_at, cancel_requested, related_resource_id, created_at, updated_at
  FROM automation_tasks`;
const transientLocalCodes = new Set(['timeout', 'connectivity', 'provider_temporary', 'sqlite_busy']);
const definitiveExternalFailures = new Set([
  'rate_limited', 'quota_limited', 'authentication', 'permission_error', 'not_configured',
  'invalid_request', 'request_pending', 'model_not_found',
]);

function timestamp(clock) {
  return new Date(clock()).toISOString();
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function safeMessage(code) {
  const messages = {
    external_outcome_unknown: 'La operación externa se interrumpió y su resultado es incierto; no se repetirá automáticamente.',
    rate_limited: 'El proveedor rechazó la solicitud por límite o cuota. Revisa el estado y vuelve a intentarlo manualmente.',
    not_configured: 'El proveedor no está configurado localmente.',
    model_not_found: 'El modelo configurado no está disponible para esta cuenta.',
    authentication: 'El proveedor rechazó la autenticación.',
    permission_error: 'La cuenta no tiene permisos para esta operación.',
    timeout: 'La operación excedió el tiempo permitido.',
    cancelled: 'La tarea fue cancelada.',
    operation_failed: 'La tarea no pudo completarse.',
    invalid_request: 'Los parámetros de la tarea no son válidos.',
    request_pending: 'La operación asociada sigue pendiente y no se duplicó.',
  };
  return messages[code] || messages.operation_failed;
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function publicTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    type: row.type,
    status: row.status,
    stage: row.stage,
    result: parseJson(row.result_json),
    errorCode: row.error_code,
    error: row.error_code ? safeMessage(row.error_code) : null,
    provider: row.provider,
    model: row.model,
    external: Boolean(row.is_external),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    cancelRequested: Boolean(row.cancel_requested),
    relatedResourceId: row.related_resource_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicProvider(row, configured = true) {
  return {
    provider: row.provider,
    model: row.model,
    configured,
    status: row.status,
    errorCode: row.error_code,
    retryAt: row.retry_at,
    updatedAt: row.updated_at,
  };
}

function errorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'rate_limited') return code;
  if (code === 'quota_limited') return code;
  if (code === 'authentication' || code === 'credentials_or_access') return 'authentication';
  if (code === 'permission_denied' || code === 'permission_error') return 'permission_error';
  if (code === 'not_configured' || code === 'provider_unavailable') return 'not_configured';
  if (code === 'no_provider') return 'not_configured';
  if (code === 'model_not_found') return code;
  if (code === 'timeout' || code === 'response_timeout') return 'timeout';
  if (code === 'cancelled') return 'cancelled';
  if (code === 'invalid_request' || code === 'unsupported_model' || code === 'invalid_input') return 'invalid_request';
  if (code === 'request_pending') return 'request_pending';
  return transientLocalCodes.has(code) ? code : 'operation_failed';
}

function providerFailureStatus(code) {
  if (code === 'rate_limited') return 'rate_limited';
  if (code === 'quota_limited') return 'quota_limited';
  if (code === 'authentication') return 'authentication_error';
  if (code === 'permission_error') return 'permission_error';
  if (code === 'not_configured') return 'not_configured';
  if (code === 'model_not_found') return 'model_unavailable';
  if (code === 'timeout') return 'timeout';
  if (code === 'connectivity' || code === 'provider_temporary' || code === 'operation_failed') return 'unavailable';
  return 'unknown';
}

export function createAutomationService({
  database,
  handlers,
  providerConfiguration = [],
  clock = Date.now,
  random = Math.random,
  maxAttempts = boundedInteger(process.env.VYRALIX_AUTOMATION_MAX_ATTEMPTS, 3, 1, 10),
  retryBaseMs = boundedInteger(process.env.VYRALIX_AUTOMATION_RETRY_BASE_MS, 1000, 100, 60_000),
  logger = console,
  leaseMs = 30_000,
  pollMs = 1500,
} = {}) {
  if (!database || !handlers) throw new Error('Automation service requires a database and handlers.');
  const active = new Map();
  let pumping = false;
  let leased = false;
  let heartbeat = null;
  let poller = null;
  let dueTimer = null;
  const workerId = randomUUID();
  const listProviders = database.prepare('SELECT * FROM automation_provider_state ORDER BY provider');
  const getSettings = database.prepare('SELECT external_operations_enabled, updated_at FROM automation_settings WHERE id = 1');
  const getTask = database.prepare(`${publicSelect} WHERE id = ?`);
  const getByKey = database.prepare(`${publicSelect} WHERE idempotency_key = ?`);
  const insertTask = database.prepare(`INSERT INTO automation_tasks
    (id, idempotency_key, request_hash, type, status, stage, params_json, is_external,
      max_attempts, attempt_key, provider, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const claimTask = database.prepare(`UPDATE automation_tasks SET status = 'running',
    stage = 'Iniciando', attempts = attempts + 1, attempt_key = ?, last_attempt_at = ?,
    next_attempt_at = NULL, cancel_requested = 0, updated_at = ?
    WHERE id = ? AND status = 'queued'
    AND (is_external = 0 OR (SELECT external_operations_enabled FROM automation_settings WHERE id = 1) = 1)`);
  const updateProvider = database.prepare(`INSERT INTO automation_provider_state
    (provider, model, status, error_code, retry_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET model = excluded.model, status = excluded.status,
    error_code = excluded.error_code, retry_at = excluded.retry_at, updated_at = excluded.updated_at`);
  const markInterruptedExternal = database.prepare(`UPDATE automation_tasks
    SET status = 'failed', stage = 'Interrumpida; resultado externo incierto',
    error_code = 'external_outcome_unknown', updated_at = ?,
    cancel_requested = 0 WHERE status = 'running' AND is_external = 1`);
  const requeueInterruptedLocal = database.prepare(`UPDATE automation_tasks
    SET status = 'queued', stage = 'Recuperada tras reinicio', updated_at = ?
    WHERE status = 'running' AND is_external = 0 AND cancel_requested = 0
    AND attempts < max_attempts`);
  const failInterruptedLocal = database.prepare(`UPDATE automation_tasks
    SET status = 'failed', stage = 'Fallida al recuperar', error_code = 'attempt_limit_reached',
    updated_at = ? WHERE status = 'running' AND is_external = 0 AND cancel_requested = 0
    AND attempts >= max_attempts`);
  const markInterruptedCancellation = database.prepare(`UPDATE automation_tasks
    SET status = 'cancelled', stage = 'Cancelada durante el reinicio',
    error_code = 'cancelled', updated_at = ?
    WHERE status = 'running' AND is_external = 0 AND cancel_requested = 1`);
  database.prepare(`INSERT OR IGNORE INTO automation_worker_lease (id, owner_id, expires_at)
    VALUES (1, NULL, '1970-01-01T00:00:00.000Z')`).run();
  const acquireLease = database.prepare(`UPDATE automation_worker_lease
    SET owner_id = ?, expires_at = ? WHERE id = 1 AND (owner_id = ? OR expires_at <= ?)`);
  const renewLease = database.prepare(`UPDATE automation_worker_lease SET expires_at = ?
    WHERE id = 1 AND owner_id = ?`);
  const releaseLease = database.prepare(`UPDATE automation_worker_lease SET owner_id = NULL,
    expires_at = ? WHERE id = 1 AND owner_id = ?`);
  const now = () => timestamp(clock);

  for (const configured of providerConfiguration) {
    if (!configured?.provider) continue;
    const existing = database.prepare('SELECT 1 FROM automation_provider_state WHERE provider = ?').get(configured.provider);
    if (!existing) {
      updateProvider.run(
        configured.provider, configured.model || null,
        configured.configured ? 'unknown' : 'not_configured',
        configured.configured ? null : 'not_configured',
        null, now(),
      );
    }
  }

  database.transaction(() => {
    const currentTime = now();
    markInterruptedExternal.run(currentTime);
    requeueInterruptedLocal.run(currentTime);
    markInterruptedCancellation.run(currentTime);
  })();

  function list(limit = 50) {
    const bounded = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 50, 100));
    return database.prepare(`${publicSelect} ORDER BY created_at DESC LIMIT ?`)
      .all(bounded).map(publicTask);
  }

  function get(id) {
    return publicTask(getTask.get(id));
  }

  function providers() {
    return listProviders.all().map((row) => {
      const config = providerConfiguration.find((item) => item.provider === row.provider);
      return publicProvider(row, Boolean(config?.configured));
    });
  }

  function settings() {
    const row = getSettings.get();
    if (!row) throw new Error('Automation settings have not been initialized.');
    return {
      externalOperationsEnabled: Boolean(row.external_operations_enabled),
      updatedAt: row.updated_at,
    };
  }

  function setExternalOperationsEnabled(enabled) {
    if (typeof enabled !== 'boolean') {
      throw Object.assign(new Error('El estado de operaciones externas debe ser booleano.'), { status: 400, code: 'invalid_setting' });
    }
    const current = now();
    const update = database.transaction(() => {
      database.prepare(`UPDATE automation_settings SET external_operations_enabled = ?, updated_at = ? WHERE id = 1`)
        .run(Number(enabled), current);
      if (enabled) {
        database.prepare(`UPDATE automation_tasks SET status = 'queued', stage = 'Autorizada; en cola',
          updated_at = ? WHERE status = 'waiting_for_external_enabled'`)
          .run(current);
      } else {
        database.prepare(`UPDATE automation_tasks SET status = 'waiting_for_external_enabled',
          stage = 'Autorizada; esperando activación global', updated_at = ?
          WHERE status = 'queued' AND is_external = 1`)
          .run(current);
      }
    });
    update.immediate();
    if (enabled) kick();
    return settings();
  }

  function recoverInterrupted() {
    const currentTime = now();
    database.transaction(() => {
      markInterruptedExternal.run(currentTime);
      requeueInterruptedLocal.run(currentTime);
      failInterruptedLocal.run(currentTime);
      markInterruptedCancellation.run(currentTime);
    })();
  }

  function tryAcquireLease() {
    const currentTime = now();
    const result = acquireLease.run(
      workerId,
      new Date(clock() + leaseMs).toISOString(),
      workerId,
      currentTime,
    );
    if (!result.changes) return false;
    const newlyAcquired = !leased;
    leased = true;
    if (newlyAcquired) {
      recoverInterrupted();
      heartbeat = setInterval(() => {
        const renewed = renewLease.run(new Date(clock() + leaseMs).toISOString(), workerId);
        if (!renewed.changes) {
          leased = false;
          for (const controller of active.values()) controller.abort(new Error('worker_lease_lost'));
        }
      }, Math.max(1000, Math.floor(leaseMs / 3)));
      heartbeat.unref?.();
    }
    return true;
  }

  function enqueue(request, idempotencyKey) {
    if (!uuidSchema.safeParse(idempotencyKey).success) {
      throw Object.assign(new Error('Se requiere Idempotency-Key con un UUID válido.'), { status: 400, code: 'invalid_idempotency_key' });
    }
    const type = request?.type;
    const schema = taskSchemas[type];
    if (!schema) throw Object.assign(new Error('Tipo de tarea no compatible.'), { status: 400, code: 'invalid_task_type' });
    const parsed = schema.safeParse(request);
    if (!parsed.success) throw Object.assign(new Error('Los parámetros de la tarea no son válidos.'), { status: 400, code: 'invalid_request' });

    const handler = handlers[type];
    if (!handler) throw Object.assign(new Error('El tipo de tarea no está habilitado en esta instalación.'), { status: 503, code: 'task_unavailable' });
    const params = { ...parsed.data };
    const provider = handler.provider?.(params) || (type === 'media_preflight' ? 'local' : null);
    const model = handler.model?.(params) || null;
    const external = Boolean(handler.external?.(params));
    const status = external ? 'waiting_for_authorization' : 'queued';
    const hash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
    const existing = getByKey.get(idempotencyKey);
    if (existing) {
      if (existing.request_hash !== hash) {
        throw Object.assign(new Error('La clave de solicitud ya se utilizó para otra tarea.'), { status: 409, code: 'idempotency_conflict' });
      }
      return publicTask(existing);
    }

    const id = randomUUID();
    const created = now();
    insertTask.run(
      id, idempotencyKey, hash, type, status,
      external ? 'Esperando autorización explícita' : 'En cola',
      JSON.stringify(params), Number(external), maxAttempts, randomUUID(),
      provider, model, created, created,
    );
    if (status === 'queued') kick();
    return get(id);
  }

  function authorize(id, confirmed) {
    if (confirmed !== true) throw Object.assign(new Error('Confirma explícitamente esta operación externa.'), { status: 400, code: 'authorization_required' });
    const row = database.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(id);
    if (!row) return null;
    if (!row.is_external || row.status !== 'waiting_for_authorization') {
      throw Object.assign(new Error('La tarea no está esperando autorización.'), { status: 409, code: 'invalid_task_state' });
    }
    const params = parseJson(row.params_json);
    const authorizedParams = row.type === 'research'
      ? { ...params, input: { ...params.input, confirmExternalSearch: true } }
      : row.type === 'proposal'
        ? { ...params, confirmExternalCost: true }
        : { ...params, confirmCost: true };
    const enabled = Boolean(getSettings.get()?.external_operations_enabled);
    database.prepare(`UPDATE automation_tasks SET params_json = ?, status = ?,
      stage = ?, updated_at = ? WHERE id = ? AND status = 'waiting_for_authorization'`)
      .run(
        JSON.stringify(authorizedParams),
        enabled ? 'queued' : 'waiting_for_external_enabled',
        enabled ? 'Autorizada; en cola' : 'Autorizada; esperando activación global',
        now(),
        id,
      );
    if (enabled) kick();
    return get(id);
  }

  function claimNext() {
    while (true) {
      const row = database.prepare(`SELECT task.* FROM automation_tasks task
        JOIN automation_settings settings ON settings.id = 1
        WHERE task.status = 'queued' AND task.attempts < task.max_attempts
        AND (task.next_attempt_at IS NULL OR task.next_attempt_at <= ?)
        AND (task.is_external = 0 OR settings.external_operations_enabled = 1)
        ORDER BY task.is_external ASC, task.created_at ASC LIMIT 1`).get(now());
      if (!row) return null;
      if (row.is_external && !externalConsentFields[row.type]?.(parseJson(row.params_json))) {
        database.prepare(`UPDATE automation_tasks SET status = 'waiting_for_authorization',
          stage = 'Esperando autorización explícita', updated_at = ? WHERE id = ? AND status = 'queued'`)
          .run(now(), row.id);
        continue;
      }
      const key = randomUUID();
      const current = now();
      const claimed = claimTask.run(key, current, current, row.id);
      if (claimed.changes) return { row: database.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(row.id), key };
    }
  }

  function finishFailure(row, error) {
    const code = errorCode(error);
    const current = now();
    const parsedRetryAfter = Number(error?.retryAfterSeconds);
    const retryAt = ['rate_limited', 'quota_limited'].includes(code) && Number.isFinite(parsedRetryAfter) && parsedRetryAfter > 0
      ? new Date(Math.min(clock() + parsedRetryAfter * 1000, 8.64e15)).toISOString()
      : null;
    const cancelled = code === 'cancelled' || Boolean(database.prepare('SELECT cancel_requested FROM automation_tasks WHERE id = ?').get(row.id)?.cancel_requested);

    if (row.provider && row.provider !== 'local') {
      const status = providerFailureStatus(code);
      if (status !== 'unknown') {
        updateProvider.run(row.provider, row.model, status, code, retryAt, current);
      }
    }
    if (cancelled) {
      database.prepare(`UPDATE automation_tasks SET status = 'cancelled', stage = 'Cancelada',
        error_code = 'cancelled', updated_at = ? WHERE id = ?`).run(current, row.id);
      return;
    }
    if (['rate_limited', 'quota_limited'].includes(code)) {
      database.prepare(`UPDATE automation_tasks SET status = 'waiting_for_quota',
        stage = 'Esperando cuota o intervención', error_code = ?, next_attempt_at = ?, updated_at = ?
        WHERE id = ?`).run(code, retryAt, current, row.id);
      return;
    }
    const retryableLocal = !row.is_external && transientLocalCodes.has(code) && row.attempts < row.max_attempts;
    if (retryableLocal) {
      const backoff = Math.min(retryBaseMs * (2 ** Math.max(0, row.attempts - 1)), 60_000);
      const delay = Math.round(backoff * (0.5 + random()));
      const nextAt = new Date(clock() + delay).toISOString();
      database.prepare(`UPDATE automation_tasks SET status = 'queued', stage = 'Reintento local programado',
        error_code = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
        .run(code, nextAt, current, row.id);
      scheduleDueTask();
      return;
    }
    const finalCode = row.is_external && !definitiveExternalFailures.has(code)
      ? 'external_outcome_unknown'
      : code;
    database.prepare(`UPDATE automation_tasks SET status = 'failed', stage = 'Fallida',
      error_code = ?, updated_at = ? WHERE id = ?`).run(finalCode, current, row.id);
  }

  async function runClaim(claimed) {
    const { row, key } = claimed;
    const handler = handlers[row.type];
    const controller = new AbortController();
    active.set(row.id, controller);
    const params = parseJson(row.params_json);
    try {
      const result = await handler.run(params, { signal: controller.signal, taskId: row.id, attemptKey: key });
      const current = database.prepare('SELECT cancel_requested FROM automation_tasks WHERE id = ?').get(row.id);
      if (controller.signal.aborted || current?.cancel_requested) {
        database.prepare(`UPDATE automation_tasks SET status = 'cancelled', stage = 'Cancelada',
          error_code = 'cancelled', updated_at = ? WHERE id = ?`).run(now(), row.id);
        return;
      }
      if (row.provider && row.provider !== 'local') {
        updateProvider.run(row.provider, row.model, 'available', null, null, now());
      }
      const output = result?.result ?? result ?? null;
      database.prepare(`UPDATE automation_tasks SET status = 'succeeded', stage = 'Completada',
        result_json = ?, error_code = NULL, provider = COALESCE(?, provider),
        model = COALESCE(?, model), related_resource_id = COALESCE(?, related_resource_id),
        updated_at = ? WHERE id = ?`)
        .run(
          output == null ? null : JSON.stringify(output),
          result?.provider || null,
          result?.model || null,
          result?.relatedResourceId || null,
          now(),
          row.id,
        );
    } catch (error) {
      finishFailure(row, error);
    } finally {
      active.delete(row.id);
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      if (!tryAcquireLease()) return;
      while (true) {
        if (!leased) break;
        const claim = claimNext();
        if (!claim) break;
        await runClaim(claim);
      }
    } catch (error) {
      logger.error(JSON.stringify({
        level: 'error',
        event: 'automation_queue_failed',
        code: typeof error?.code === 'string' ? error.code : 'queue_error',
      }));
    } finally {
      pumping = false;
      scheduleDueTask();
    }
  }

  function kick() {
    void pump();
  }

  function scheduleDueTask() {
    if (dueTimer) return;
    const next = database.prepare(`SELECT MIN(next_attempt_at) AS next_at FROM automation_tasks
      WHERE status = 'queued' AND next_attempt_at IS NOT NULL AND attempts < max_attempts`).get().next_at;
    if (!next) return;
    const delay = Math.max(0, Date.parse(next) - clock());
    dueTimer = setTimeout(() => {
      dueTimer = null;
      kick();
    }, delay);
    dueTimer.unref?.();
  }

  function cancel(id) {
    const row = database.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(id);
    if (!row) return null;
    if (['succeeded', 'failed', 'cancelled'].includes(row.status)) {
      throw Object.assign(new Error('La tarea ya terminó y no se puede cancelar.'), { status: 409, code: 'invalid_task_state' });
    }
    const updatedAt = now();
    if (row.status === 'running') {
      database.prepare(`UPDATE automation_tasks SET cancel_requested = 1,
        stage = 'Cancelación solicitada', updated_at = ? WHERE id = ?`).run(updatedAt, id);
      active.get(id)?.abort(new Error('cancelled'));
    } else {
      database.prepare(`UPDATE automation_tasks SET status = 'cancelled', cancel_requested = 1,
        stage = 'Cancelada antes de iniciar', error_code = 'cancelled', updated_at = ? WHERE id = ?`)
        .run(updatedAt, id);
    }
    return get(id);
  }

  function retry(id, confirmed) {
    const row = database.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(id);
    if (!row) return null;
    if (row.is_external && confirmed !== true) {
      throw Object.assign(new Error('Confirma explícitamente que autorizas otro intento externo.'), { status: 400, code: 'authorization_required' });
    }
    if (row.status === 'waiting_for_quota') {
      if (row.next_attempt_at && Date.parse(row.next_attempt_at) > clock()) {
        throw Object.assign(new Error(`El proveedor indicó esperar hasta ${row.next_attempt_at}.`), { status: 429, code: 'retry_after_active' });
      }
    } else if (row.status !== 'failed') {
      throw Object.assign(new Error('Solo se pueden reintentar tareas fallidas o en espera de cuota.'), { status: 409, code: 'invalid_task_state' });
    }
    if (row.error_code === 'external_outcome_unknown') {
      throw Object.assign(new Error('No es seguro repetir esta operación externa porque su resultado anterior es incierto.'), { status: 409, code: 'external_outcome_unknown' });
    }
    if (['authentication', 'permission_error', 'not_configured', 'invalid_request', 'request_pending'].includes(row.error_code)) {
      throw Object.assign(new Error('Resuelve primero el problema de configuración, permisos o parámetros antes de volver a intentarlo.'), { status: 409, code: 'retry_requires_intervention' });
    }
    if (row.attempts >= row.max_attempts) {
      throw Object.assign(new Error('La tarea alcanzó su máximo de intentos.'), { status: 409, code: 'attempt_limit_reached' });
    }
    const params = parseJson(row.params_json);
    if (row.is_external) {
      if (row.type === 'research') params.input.confirmExternalSearch = true;
      else if (row.type === 'proposal') params.confirmExternalCost = true;
      else if (row.type === 'image_generation') params.confirmCost = true;
    }
    const enabled = !row.is_external || Boolean(getSettings.get()?.external_operations_enabled);
    database.prepare(`UPDATE automation_tasks SET status = ?, stage = ?,
      params_json = ?, error_code = NULL, attempt_key = ?, next_attempt_at = NULL,
      cancel_requested = 0, updated_at = ? WHERE id = ?`)
      .run(
        enabled ? 'queued' : 'waiting_for_external_enabled',
        enabled ? 'Reintento autorizado' : 'Reintento autorizado; esperando activación global',
        JSON.stringify(params), randomUUID(), now(), id,
      );
    if (enabled) kick();
    return get(id);
  }

  async function shutdown() {
    if (poller) clearInterval(poller);
    for (const controller of active.values()) controller.abort(new Error('shutdown'));
    while (pumping) await new Promise((resolve) => setTimeout(resolve, 20));
    if (heartbeat) clearInterval(heartbeat);
    if (dueTimer) clearTimeout(dueTimer);
    if (leased) releaseLease.run(now(), workerId);
    leased = false;
  }

  tryAcquireLease();
  poller = setInterval(() => {
    kick();
    scheduleDueTask();
  }, pollMs);
  poller.unref?.();
  kick();

  return { enqueue, get, list, providers, settings, setExternalOperationsEnabled, authorize, cancel, retry, shutdown };
}
