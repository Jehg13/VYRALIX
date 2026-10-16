import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('API persists content, validates transitions, runs safe local jobs, and creates backups', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vyralix-test-'));
  process.env.VYRALIX_DB_PATH = join(directory, 'vyralix.sqlite');
  const { createApp, processPendingJobs, recoverInterruptedJobs } = await import('../src/app.js');
  const { createProviderRouter } = await import('../src/ai/provider-router.js');
  const { closeDatabase, db } = await import('../src/db.js');
  const validVariant = (title) => ({
    title,
    idea: 'Una idea clara y original para explicar algo cotidiano.',
    hook: '¿Te has preguntado por qué pasa esto?',
    script: 'Primero observa el detalle. Después explica una causa con claridad y termina con una pregunta para conversar.',
    description: 'Una explicación breve para guardar y compartir.',
    hashtags: ['ideas', 'curiosidades'],
    format: 'explicativo',
    durationSeconds: 30,
    imageText: '',
    mediaPrompt: '',
    warnings: [],
  });
  let generationCalls = 0;
  let providerPriority = ['gemini', 'groq', 'ollama'];
  const aiRouter = {
    priority: () => providerPriority,
    providerSummaries: () => [{
      id: 'gemini', name: 'Gemini', model: 'test-model', configured: true, missing: [],
      capabilities: ['structured_text'], priority: 1, availability: 'unknown', checkedAt: null,
      availableModels: [], lastError: null, lastRunAt: null, isPaid: false,
    }],
    checkProviders: async () => [{ id: 'gemini', availability: 'available', errorCode: null }],
    generate: async ({ input }) => {
      generationCalls += 1;
      return {
        variants: Array.from({ length: input.variants }, (_, index) => validVariant(`Variante ${index + 1}`)),
        provider: 'gemini', model: 'test-model', attempts: 1, fallbackReason: null,
        usage: { inputTokens: 200, outputTokens: 120 },
      };
    },
  };
  const server = createApp({ aiRouter }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const request = (path, options) => fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  try {
    assert.equal((await request('/health')).status, 200);

    const invalid = await request('/posts', { method: 'POST', body: JSON.stringify({ title: '', category: 'Ideas' }) });
    assert.equal(invalid.status, 400);
    const unsafeStatus = await request('/posts', { method: 'POST', body: JSON.stringify({ title: 'Falso publicado', category: 'Ideas', status: 'published' }) });
    assert.equal(unsafeStatus.status, 400);

    const createdResponse = await request('/posts', { method: 'POST', body: JSON.stringify({ title: 'Guion de prueba', category: 'Educación', body: 'Contenido original' }) });
    assert.equal(createdResponse.status, 201);
    let post = await createdResponse.json();
    assert.equal(post.status, 'draft');

    const invalidTransition = await request(`/posts/${post.id}`, {
      method: 'PUT',
      body: JSON.stringify({ title: post.title, category: post.category, body: post.body, status: 'published' }),
    });
    assert.equal(invalidTransition.status, 409);

    for (const status of ['pending_review', 'approved']) {
      const response = await request(`/posts/${post.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      assert.equal(response.status, 200);
      post = await response.json();
    }
    const scheduleAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const scheduled = await request(`/posts/${post.id}`, {
      method: 'PUT',
      body: JSON.stringify({ title: post.title, category: post.category, body: post.body, status: 'scheduled', scheduledAt: scheduleAt }),
    });
    assert.equal(scheduled.status, 200);
    post = await scheduled.json();
    assert.equal(post.status, 'scheduled');

    const jobResponse = await request('/jobs', { method: 'POST', body: JSON.stringify({ postId: post.id }) });
    assert.equal(jobResponse.status, 201);
    const job = await jobResponse.json();
    db.prepare("UPDATE jobs SET status = 'processing' WHERE id = ?").run(job.id);
    assert.equal(recoverInterruptedJobs(), 1);
    assert.equal(processPendingJobs(), true);
    const duplicateJob = await request('/jobs', { method: 'POST', body: JSON.stringify({ postId: post.id }) });
    assert.equal(duplicateJob.status, 409);
    const jobs = await (await request('/jobs')).json();
    assert.equal(jobs[0].status, 'completed');
    assert.match(jobs[0].result, /No se realizó ninguna publicación externa/);

    const backup = await request('/backup', { method: 'POST', body: '{}' });
    assert.equal(backup.status, 201);
    const backupInfo = await backup.json();
    assert.ok((await stat(backupInfo.path)).size > 0);

    const dashboard = await (await request('/dashboard')).json();
    assert.equal(dashboard.posts.scheduled, 1);
    assert.equal(dashboard.jobs.completed, 1);
    assert.equal(db.prepare('SELECT title FROM posts WHERE id = ?').get(post.id).title, post.title);
    assert.equal((await request(`/posts/${post.id}`, { method: 'DELETE' })).status, 409);

    const crudPost = await (await request('/posts', {
      method: 'POST',
      body: JSON.stringify({ title: 'Borrador CRUD', category: 'Ideas' }),
    })).json();
    const edited = await request(`/posts/${crudPost.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...crudPost, title: 'Borrador editado' }),
    });
    assert.equal((await edited.json()).title, 'Borrador editado');
    assert.equal((await request(`/posts/${crudPost.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await request(`/posts/${crudPost.id}`)).status, 404);

    const aiInput = {
      category: 'Curiosidades',
      audience: 'Público general adulto',
      tone: 'natural y cercano',
      creativeGoal: 'explicar algo cotidiano',
      format: 'explicativo',
      durationSeconds: 30,
      variants: 2,
      restrictions: '',
      provider: 'auto',
    };
    const invalidGeneration = await request('/ai/generations', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ ...aiInput, variants: 20 }),
    });
    assert.equal(invalidGeneration.status, 400);
    assert.equal(generationCalls, 0);

    const generationId = randomUUID();
    const generate = () => request('/ai/generations', {
      method: 'POST',
      headers: { 'Idempotency-Key': generationId },
      body: JSON.stringify(aiInput),
    });
    const generationResponse = await generate();
    assert.equal(generationResponse.status, 201);
    const generation = await generationResponse.json();
    assert.equal(generation.status, 'completed');
    assert.equal(generation.variants.length, 2);
    assert.equal(generation.provider, 'gemini');
    assert.equal(generation.cost.kind, 'unknown');
    assert.equal(JSON.stringify(generation).includes('API_KEY'), false);
    assert.equal((await generate()).status, 200);
    assert.equal(generationCalls, 1);

    const saved = await request(`/ai/generations/${generationId}/save`, {
      method: 'POST',
      body: JSON.stringify({ variantIndex: 0, variant: { ...generation.variants[0], title: 'Guion creado por IA' } }),
    });
    assert.equal(saved.status, 201);
    const savedPost = await saved.json();
    assert.equal(savedPost.status, 'draft');
    assert.match(savedPost.source, /gemini/i);
    const savedAgain = await request(`/ai/generations/${generationId}/save`, {
      method: 'POST',
      body: JSON.stringify({ variantIndex: 0 }),
    });
    assert.equal((await savedAgain.json()).id, savedPost.id);
    assert.equal((await request(`/ai/generations/${generationId}/discard`, {
      method: 'POST',
      body: JSON.stringify({ variantIndex: 1 }),
    })).status, 204);
    assert.equal((await request(`/ai/generations/${generationId}/save`, {
      method: 'POST',
      body: JSON.stringify({ variantIndex: 1 }),
    })).status, 409);
    assert.equal((await request(`/ai/generations/${generationId}`)).status, 200);
    assert.equal((await request('/ai/generations')).status, 200);
    const providerInfo = await (await request('/ai/providers')).json();
    assert.deepEqual(providerInfo.priority, providerPriority);
    assert.equal(JSON.stringify(providerInfo).includes('GEMINI_API_KEY='), false);
    const changedPriority = ['ollama', 'gemini', 'groq'];
    assert.equal((await request('/ai/providers/priority', {
      method: 'PUT',
      body: JSON.stringify({ priority: changedPriority }),
    })).status, 200);
    providerPriority = changedPriority;
    assert.equal((await request('/ai/providers/priority', {
      method: 'PUT',
      body: JSON.stringify({ priority: ['gemini', 'gemini', 'ollama'] }),
    })).status, 400);

    const noProviders = createProviderRouter({
      database: db,
      config: {
        geminiApiKey: '', geminiModel: '', groqApiKey: '', groqModel: '',
        ollamaBaseUrl: 'http://127.0.0.1:11434', ollamaModel: '',
      },
    });
    const unavailableServer = createApp({ aiRouter: noProviders }).listen(0, '127.0.0.1');
    await new Promise((resolve) => unavailableServer.once('listening', resolve));
    const unavailableAddress = unavailableServer.address();
    const unavailableId = randomUUID();
    try {
      const unavailableUrl = `http://127.0.0.1:${unavailableAddress.port}/api/v1/ai/generations`;
      const unavailableResponse = await fetch(unavailableUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': unavailableId },
        body: JSON.stringify(aiInput),
      });
      assert.equal(unavailableResponse.status, 503);
      const unavailablePayload = await unavailableResponse.json();
      assert.equal(typeof unavailablePayload.error, 'string');
      assert.match(unavailablePayload.error, /No hay proveedores/i);
      assert.equal(unavailablePayload.code, 'no_provider');
      assert.equal(unavailablePayload.generation.status, 'failed');
      const unavailableRetry = await fetch(unavailableUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': unavailableId },
        body: JSON.stringify(aiInput),
      });
      assert.equal(unavailableRetry.status, 409);
      assert.equal(typeof (await unavailableRetry.json()).error, 'string');
    } finally {
      await new Promise((resolve, reject) => unavailableServer.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
    delete process.env.VYRALIX_DB_PATH;
  }
});
