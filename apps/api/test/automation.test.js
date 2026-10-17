import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import test from 'node:test';
import { createAutomationService } from '../src/automation/service.js';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(resolve(here, '../migrations/009_automation_tasks.sql'), 'utf8');
const externalSwitchMigration = readFileSync(resolve(here, '../migrations/010_automation_external_switch.sql'), 'utf8');

function createDatabase() {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  database.exec(migration);
  database.exec(externalSwitchMigration);
  return database;
}

async function waitForTask(service, id, predicate = (task) => ['succeeded', 'failed', 'cancelled'].includes(task.status)) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const task = service.get(id);
    if (task && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${id} did not reach the expected state: ${service.get(id)?.status}`);
}

function localHandlers(run = async () => ({ result: { checks: 2 } })) {
  return {
    media_preflight: { external: () => false, provider: () => 'local', run },
    research: { external: () => true, provider: () => 'gemini', model: () => 'test-search', run },
  };
}

test('persistent task queue deduplicates requests and keeps task parameters private', async () => {
  const database = createDatabase();
  let calls = 0;
  const service = createAutomationService({
    database,
    handlers: localHandlers(async () => {
      calls += 1;
      return { result: { checks: 2 } };
    }),
    providerConfiguration: [{ provider: 'local', configured: true }],
  });
  try {
    const key = randomUUID();
    const request = { type: 'media_preflight' };
    const first = service.enqueue(request, key);
    const replay = service.enqueue(request, key);
    assert.equal(replay.id, first.id);
    assert.ok(['queued', 'running'].includes(first.status));
    const complete = await waitForTask(service, first.id);
    assert.equal(complete.status, 'succeeded');
    assert.deepEqual(complete.result, { checks: 2 });
    assert.equal(calls, 1);
    assert.equal(Object.hasOwn(complete, 'params'), false);
    assert.throws(() => service.enqueue({ type: 'media_preflight' }, randomUUID().replace(/./u, 'x')), { code: 'invalid_idempotency_key' });
    assert.throws(() => service.enqueue({ type: 'media_preflight', apiKey: 'secret' }, randomUUID()), { code: 'invalid_request' });
  } finally {
    await service.shutdown();
    database.close();
  }
});

test('external switch migration preserves queued tasks and defaults to disabled', () => {
  const database = new Database(':memory:');
  try {
    database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    database.exec(migration);
    const createdAt = new Date().toISOString();
    const taskId = randomUUID();
    const queuedTaskId = randomUUID();
    database.prepare(`INSERT INTO automation_tasks
      (id, idempotency_key, request_hash, type, status, stage, params_json, is_external,
       max_attempts, attempt_key, provider, created_at, updated_at)
      VALUES (?, ?, 'hash', 'research', 'waiting_for_authorization', 'Esperando autorización', '{}', 1, 3, ?, 'gemini', ?, ?)`)
      .run(taskId, randomUUID(), randomUUID(), createdAt, createdAt);
    database.prepare(`INSERT INTO automation_tasks
      (id, idempotency_key, request_hash, type, status, stage, params_json, is_external,
       max_attempts, attempt_key, provider, created_at, updated_at)
      VALUES (?, ?, 'hash', 'research', 'queued', 'Autorizada; en cola', ?, 1, 3, ?, 'gemini', ?, ?)`)
      .run(queuedTaskId, randomUUID(), JSON.stringify({ type: 'research', input: { confirmExternalSearch: true } }), randomUUID(), createdAt, createdAt);
    database.exec(externalSwitchMigration);
    assert.equal(database.prepare('SELECT status FROM automation_tasks WHERE id = ?').get(taskId).status, 'waiting_for_authorization');
    assert.equal(database.prepare('SELECT status FROM automation_tasks WHERE id = ?').get(queuedTaskId).status, 'waiting_for_external_enabled');
    assert.equal(database.prepare('SELECT external_operations_enabled FROM automation_settings WHERE id = 1').get().external_operations_enabled, 0);
    assert.ok(database.prepare('SELECT 1 FROM schema_migrations WHERE version = 10').get());
  } finally {
    database.close();
  }
});

test('external tasks wait for explicit authorization and separate provider state from availability claims', async () => {
  const database = createDatabase();
  let calls = 0;
  const service = createAutomationService({
    database,
    handlers: localHandlers(async () => { calls += 1; return { result: { researchId: 'stored' } }; }),
    providerConfiguration: [{ provider: 'gemini', model: 'test-search', configured: true }],
  });
  try {
    const task = service.enqueue({ type: 'research', input: {
      niche: 'ciencia', audience: 'adultos', market: 'México', language: 'Español',
      goal: 'informar', format: 'explicativo', durationSeconds: 30,
    } }, randomUUID());
    assert.equal(task.status, 'waiting_for_authorization');
    assert.equal(calls, 0);
    assert.equal(service.settings().externalOperationsEnabled, false);
    assert.equal(service.providers()[0].status, 'unknown');
    assert.throws(() => service.authorize(task.id, false), { code: 'authorization_required' });
    service.authorize(task.id, true);
    assert.equal(service.get(task.id).status, 'waiting_for_external_enabled');
    assert.equal(calls, 0);
    service.setExternalOperationsEnabled(true);
    const complete = await waitForTask(service, task.id);
    assert.equal(complete.status, 'succeeded');
    assert.equal(calls, 1);
    assert.equal(service.providers()[0].status, 'available');
  } finally {
    await service.shutdown();
    database.close();
  }
});

test('global external switch persists, blocks queued calls, and leaves running operations untouched when disabled', async () => {
  const database = createDatabase();
  let calls = 0;
  let resolveExternal;
  let enteredExternal;
  const entered = new Promise((resolve) => { enteredExternal = resolve; });
  const handlers = localHandlers();
  handlers.research.run = async () => {
    calls += 1;
    if (calls === 1) {
      enteredExternal();
      return new Promise((resolve) => { resolveExternal = resolve; });
    }
    return { result: { researchId: 'second' } };
  };
  const service = createAutomationService({ database, handlers });
  try {
    const externalTask = service.enqueue({ type: 'research', input: {
      niche: 'ciencia', audience: 'adultos', market: 'México', language: 'Español',
      goal: 'informar', format: 'explicativo', durationSeconds: 30,
    } }, randomUUID());
    service.authorize(externalTask.id, true);
    assert.equal(service.get(externalTask.id).status, 'waiting_for_external_enabled');
    assert.equal(calls, 0);

    const localTask = service.enqueue({ type: 'media_preflight' }, randomUUID());
    assert.equal((await waitForTask(service, localTask.id)).status, 'succeeded');
    assert.equal(calls, 0);

    service.setExternalOperationsEnabled(true);
    await entered;
    assert.equal(service.get(externalTask.id).status, 'running');
    const waitingTask = service.enqueue({ type: 'research', input: {
      niche: 'tecnología', audience: 'adultos', market: 'México', language: 'Español',
      goal: 'informar', format: 'explicativo', durationSeconds: 30,
    } }, randomUUID());
    service.authorize(waitingTask.id, true);
    assert.equal(service.get(waitingTask.id).status, 'queued');
    service.setExternalOperationsEnabled(false);
    assert.equal(service.get(externalTask.id).status, 'running');
    assert.equal(service.get(waitingTask.id).status, 'waiting_for_external_enabled');
    resolveExternal({ result: { researchId: 'persisted' } });
    assert.equal((await waitForTask(service, externalTask.id)).status, 'succeeded');
    assert.equal(service.get(waitingTask.id).status, 'waiting_for_external_enabled');
    assert.equal(calls, 1);
    service.setExternalOperationsEnabled(true);
    assert.equal((await waitForTask(service, waitingTask.id)).status, 'succeeded');
    assert.equal(calls, 2);
    service.setExternalOperationsEnabled(false);
    assert.equal(service.settings().externalOperationsEnabled, false);
  } finally {
    resolveExternal?.({ result: { researchId: 'test-cleanup' } });
    await service.shutdown();
    database.close();
  }
});

test('only one worker claims tasks and restart recovery never repeats an interrupted external operation', async () => {
  const database = createDatabase();
  let calls = 0;
  const handlers = localHandlers(async () => {
    calls += 1;
    return { result: { local: true } };
  });
  const first = createAutomationService({ database, handlers });
  const second = createAutomationService({ database, handlers });
  try {
    const queued = first.enqueue({ type: 'media_preflight' }, randomUUID());
    assert.equal((await waitForTask(first, queued.id)).status, 'succeeded');
    assert.equal(calls, 1);

    const now = new Date().toISOString();
    const interruptedExternal = randomUUID();
    database.prepare(`INSERT INTO automation_tasks
      (id, idempotency_key, request_hash, type, status, stage, params_json, is_external, attempts,
       max_attempts, attempt_key, provider, created_at, updated_at)
      VALUES (?, ?, 'hash', 'research', 'running', 'En curso', '{}', 1, 1, 3, ?, 'gemini', ?, ?)`)
      .run(interruptedExternal, randomUUID(), randomUUID(), now, now);
    await first.shutdown();
    await second.shutdown();
    database.prepare("UPDATE automation_worker_lease SET owner_id = NULL, expires_at = '1970-01-01T00:00:00.000Z' WHERE id = 1").run();
    const recovery = createAutomationService({ database, handlers });
    const interrupted = await waitForTask(recovery, interruptedExternal);
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.errorCode, 'external_outcome_unknown');
    assert.throws(() => recovery.retry(interruptedExternal, true), { code: 'external_outcome_unknown' });
    assert.equal(calls, 1);
    await recovery.shutdown();
  } finally {
    await first.shutdown();
    await second.shutdown();
    database.close();
  }
});

test('tasks persist in SQLite and restart recovery requeues safe local work but quarantines active external work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vyralix-automation-recovery-'));
  const databasePath = join(directory, 'automation.sqlite');
  let database = new Database(databasePath);
  let service;
  try {
    database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    database.exec(migration);
    database.exec(externalSwitchMigration);
    service = createAutomationService({ database, handlers: localHandlers() });
    const createdAt = new Date().toISOString();
    const localId = randomUUID();
    const externalId = randomUUID();
    for (const [id, type, external, provider] of [
      [localId, 'media_preflight', 0, 'local'],
      [externalId, 'research', 1, 'gemini'],
    ]) {
      database.prepare(`INSERT INTO automation_tasks
        (id, idempotency_key, request_hash, type, status, stage, params_json, is_external, attempts,
         max_attempts, attempt_key, provider, created_at, updated_at)
        VALUES (?, ?, 'hash', ?, 'running', 'En curso', '{}', ?, 1, 3, ?, ?, ?, ?)`)
        .run(id, randomUUID(), type, external, randomUUID(), provider, createdAt, createdAt);
    }
    await service.shutdown();
    database.close();

    database = new Database(databasePath);
    service = createAutomationService({ database, handlers: localHandlers() });
    const external = await waitForTask(service, externalId);
    assert.equal(external.status, 'failed');
    assert.equal(external.errorCode, 'external_outcome_unknown');
    const local = await waitForTask(service, localId);
    assert.equal(local.status, 'succeeded');
    assert.ok(database.prepare("SELECT 1 FROM automation_tasks WHERE id = ?").get(localId));
    assert.equal(service.settings().externalOperationsEnabled, false);
  } finally {
    if (service) await service.shutdown();
    if (database.open) database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancellation reaches a running worker and quota Retry-After requires a confirmed manual retry', async () => {
  const database = createDatabase();
  let clock = Date.now();
  let quotaCalls = 0;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const service = createAutomationService({
    database,
    clock: () => clock,
    retryBaseMs: 1,
    handlers: {
      ...localHandlers(),
      image_generation: {
        external: () => true,
        provider: () => 'gemini_image',
        model: () => 'image-test',
        run: async (_params, { signal }) => {
          quotaCalls += 1;
          if (quotaCalls === 1) throw Object.assign(new Error('secret provider response'), { code: 'rate_limited', retryAfterSeconds: 45 });
          started();
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })), { once: true });
          });
        },
      },
    },
    providerConfiguration: [{ provider: 'gemini_image', model: 'image-test', configured: true }],
  });
  try {
    service.setExternalOperationsEnabled(true);
    const queued = service.enqueue({
      type: 'image_generation', provider: 'gemini', model: 'image-test', prompt: 'Prueba segura de imagen',
    }, randomUUID());
    service.authorize(queued.id, true);
    const limited = await waitForTask(service, queued.id, (task) => task.status === 'waiting_for_quota');
    assert.equal(limited.errorCode, 'rate_limited');
    assert.equal(limited.nextAttemptAt, new Date(clock + 45_000).toISOString());
    assert.equal(quotaCalls, 1);
    assert.throws(() => service.retry(queued.id, true), { code: 'retry_after_active' });
    clock += 46_000;
    service.retry(queued.id, true);
    await startedPromise;
    assert.equal(service.get(queued.id).status, 'running');
    service.cancel(queued.id);
    const cancelled = await waitForTask(service, queued.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(quotaCalls, 2);
    assert.doesNotMatch(JSON.stringify(service.list()), /secret provider response/);
  } finally {
    await service.shutdown();
    database.close();
  }
});

test('local transient failures use bounded retries with jitter while external timeouts are never retried', async () => {
  const database = createDatabase();
  let localCalls = 0;
  let externalCalls = 0;
  const service = createAutomationService({
    database,
    retryBaseMs: 1,
    random: () => 0,
    handlers: {
      ...localHandlers(async () => {
        localCalls += 1;
        if (localCalls < 3) throw Object.assign(new Error('temporary local issue'), { code: 'connectivity' });
        return { result: { ok: true } };
      }),
      research: {
        external: () => true,
        provider: () => 'gemini',
        run: async () => {
          externalCalls += 1;
          throw Object.assign(new Error('request timed out'), { code: 'timeout' });
        },
      },
    },
  });
  try {
    service.setExternalOperationsEnabled(true);
    const local = service.enqueue({ type: 'media_preflight' }, randomUUID());
    assert.equal((await waitForTask(service, local.id)).status, 'succeeded');
    assert.equal(localCalls, 3);
    const external = service.enqueue({ type: 'research', input: {
      niche: 'ciencia', audience: 'adultos', market: 'México', language: 'Español',
      goal: 'informar', format: 'explicativo', durationSeconds: 30,
    } }, randomUUID());
    service.authorize(external.id, true);
    const uncertain = await waitForTask(service, external.id);
    assert.equal(uncertain.errorCode, 'external_outcome_unknown');
    assert.equal(externalCalls, 1);
    assert.throws(() => service.retry(external.id, true), { code: 'external_outcome_unknown' });
  } finally {
    await service.shutdown();
    database.close();
  }
});

test('automation API exposes task state and local preflight without calling unauthorised providers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vyralix-automation-api-'));
  const previousDatabasePath = process.env.VYRALIX_DB_PATH;
  process.env.VYRALIX_DB_PATH = join(directory, 'vyralix.sqlite');
  const { createApp } = await import('../src/app.js');
  const { closeDatabase, db } = await import('../src/db.js');
  let externalCalls = 0;
  const app = createApp({
    researchFetch: async () => { externalCalls += 1; throw new Error('Research API must stay unauthorised.'); },
    imageGenerationFetch: async () => { externalCalls += 1; throw new Error('Image API must stay unauthorised.'); },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const request = (path, options = {}) => fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  try {
    assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE version = 10').get());
    const providers = await (await request('/automation/providers')).json();
    assert.equal(JSON.stringify(providers).includes('GEMINI_API_KEY='), false);
    const settings = await (await request('/automation/settings')).json();
    assert.equal(settings.externalOperationsEnabled, false);
    const invalidSettings = await request('/automation/settings', {
      method: 'PUT',
      body: JSON.stringify({ externalOperationsEnabled: 'true' }),
    });
    assert.equal(invalidSettings.status, 400);
    const enabled = await request('/automation/settings', {
      method: 'PUT',
      body: JSON.stringify({ externalOperationsEnabled: true }),
    });
    assert.equal((await enabled.json()).externalOperationsEnabled, true);
    const disabled = await request('/automation/settings', {
      method: 'PUT',
      body: JSON.stringify({ externalOperationsEnabled: false }),
    });
    assert.equal((await disabled.json()).externalOperationsEnabled, false);

    const localResponse = await request('/automation/tasks', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ type: 'media_preflight' }),
    });
    assert.equal(localResponse.status, 202);
    const localTask = (await localResponse.json()).task;
    const deadline = Date.now() + 3000;
    let recovered;
    while (Date.now() < deadline) {
      recovered = (await (await request(`/automation/tasks/${localTask.id}`)).json()).task;
      if (recovered.status === 'succeeded' || recovered.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(recovered.status, 'succeeded');
    assert.equal(recovered.provider, 'local');

    const externalResponse = await request('/automation/tasks', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({
        type: 'research',
        input: {
          niche: 'Tema no sensible', audience: 'Adultos', market: 'México', language: 'Español',
          goal: 'Informar', format: 'Explicativo', durationSeconds: 30,
        },
      }),
    });
    assert.equal(externalResponse.status, 202);
    const externalTask = (await externalResponse.json()).task;
    assert.equal(externalTask.status, 'waiting_for_authorization');
    assert.equal(externalTask.params, undefined);
    const refusedAuthorization = await request(`/automation/tasks/${externalTask.id}/authorize`, {
      method: 'POST',
      body: JSON.stringify({ confirmExternalOperation: false }),
    });
    assert.equal(refusedAuthorization.status, 400);
    await request(`/automation/tasks/${externalTask.id}/cancel`, { method: 'POST', body: '{}' });
    assert.equal(externalCalls, 0);
  } finally {
    await app.locals.automationService.shutdown();
    await app.locals.mediaService.shutdown();
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    if (previousDatabasePath === undefined) delete process.env.VYRALIX_DB_PATH;
    else process.env.VYRALIX_DB_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
});
