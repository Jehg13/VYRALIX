import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('research requires consent, saves grounded sources and drafts, and sends approved content through Media Studio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vyralix-research-test-'));
  process.env.VYRALIX_DB_PATH = join(directory, 'vyralix.sqlite');
  const { createApp } = await import('../src/app.js');
  const { closeDatabase, db } = await import('../src/db.js');
  const { createResearchService } = await import('../src/research/service.js');
  const unavailableService = createResearchService({
    database: db,
    aiRouter: {},
    fetchImpl: async () => { throw new Error('No debe llamar al proveedor sin configuración.'); },
    config: { geminiApiKey: '', geminiModel: '', timeoutMs: 1000 },
  });
  assert.equal(unavailableService.capabilities().configured, false);
  await assert.rejects(
    unavailableService.search({
      niche: 'Tema sin consentimiento', audience: 'Adultos', market: 'México', language: 'Español',
      goal: 'Informar', format: 'Explicativo', durationSeconds: 30, confirmExternalSearch: false,
    }, randomUUID()),
    (error) => error.code === 'invalid_input',
  );
  await assert.rejects(
    unavailableService.search({
      niche: 'Tema sin credenciales', audience: 'Adultos', market: 'México', language: 'Español',
      goal: 'Informar', format: 'Explicativo', durationSeconds: 30, confirmExternalSearch: true,
    }, randomUUID()),
    (error) => error.code === 'provider_unavailable',
  );
  let lockedSearchCalls = 0;
  const lockedService = createResearchService({
    database: db,
    aiRouter: {},
    fetchImpl: async () => { lockedSearchCalls += 1; throw new Error('A locked search must not reach the provider.'); },
    config: { geminiApiKey: 'test-api-key', geminiModel: 'test-search-model', timeoutMs: 1000 },
  });
  await assert.rejects(
    lockedService.search({
      niche: 'Tema sin llamada externa', audience: 'Adultos', market: 'México', language: 'Español',
      goal: 'Informar', format: 'Explicativo', durationSeconds: 30, confirmExternalSearch: true,
    }, randomUUID()),
    (error) => error.code === 'external_operations_disabled' && error.status === 423,
  );
  assert.equal(lockedSearchCalls, 0);
  db.prepare('UPDATE automation_settings SET external_operations_enabled = 1 WHERE id = 1').run();
  const citationUrl = 'https://example.org/sleep-research';
  const searchAnswer = JSON.stringify({
    summary: 'Los resultados consultados analizan hábitos de sueño y su relación con la atención.',
    findings: [{
      statement: 'Una fuente describe asociaciones entre la calidad del sueño y la atención.',
      sourceUrls: [citationUrl],
      evidenceLevel: 'reported',
    }],
    angles: [{ title: 'El sueño y la concentración', hook: '¿Dormir mal cambia tu enfoque?', rationale: 'Permite explicar una relación cotidiana sin prometer causalidad.' }],
  });
  const sourceStart = searchAnswer.indexOf('Una fuente');
  let externalSearchCalls = 0;
  let proposalCalls = 0;
  const researchFetch = async (url, options) => {
    externalSearchCalls += 1;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(options.headers['x-goog-api-key'], 'test-api-key');
    const requestBody = JSON.parse(options.body);
    if (requestBody.input.includes('Tema con demora')) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('mock timeout')), { once: true });
      });
    }
    if (options.body.includes('Tema sin fuentes')) {
      return new Response(JSON.stringify({
        steps: [
          { type: 'google_search_call', arguments: { queries: ['Tema sin fuentes'] } },
          {
            type: 'model_output',
            content: [{
              type: 'text',
              text: JSON.stringify({ summary: 'Respuesta sin fuentes verificables.', findings: [], angles: [] }),
              annotations: [{ type: 'url_citation', url: 'http://untrusted.example/test', title: 'No segura' }],
            }],
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (options.body.includes('Tema sin búsqueda')) {
      return new Response(JSON.stringify({
        steps: [{
          type: 'model_output',
          content: [{
            type: 'text',
            text: searchAnswer,
            annotations: [{
              type: 'url_citation',
              start_index: sourceStart,
              end_index: sourceStart + 'Una fuente describe asociaciones entre la calidad del sueño y la atención.'.length,
              url: citationUrl,
              title: 'Cita sin búsqueda confirmada',
            }],
          }],
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    assert.equal(JSON.parse(options.body).store, false);
    const payload = {
      steps: [
        { type: 'google_search_call', arguments: { queries: ['calidad del sueño y atención'] } },
        {
          type: 'model_output',
          content: [{
            type: 'text',
            text: searchAnswer,
            annotations: [{
              type: 'url_citation',
              start_index: sourceStart,
              end_index: sourceStart + 'Una fuente describe asociaciones entre la calidad del sueño y la atención.'.length,
              url: citationUrl,
              title: 'Estudio de sueño',
            }],
          }],
        },
      ],
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const proposal = {
    title: 'Sueño y enfoque',
    centralIdea: 'Explicar con prudencia la relación entre el descanso y la atención.',
    targetAudience: 'Público general',
    hook: '¿Dormir mal afecta tu concentración?',
    narrativeDevelopment: 'Presenta el hallazgo como una asociación y distingue correlación de causalidad.',
    durationSeconds: 30,
    description: 'Una explicación breve sobre descanso y atención.',
    hashtags: ['#sueño', '#bienestar'],
    claims: [{ statement: 'Una fuente describe una asociación con la atención.', sourceIds: [], evidenceLevel: 'inference' }],
    scenes: [
      { order: 1, durationSeconds: 10, voiceover: '¿Dormir mal afecta tu concentración?', visualProposal: 'Persona preparando su espacio para dormir.', sourceIds: [] },
      { order: 2, durationSeconds: 10, voiceover: 'Una fuente describe una asociación entre descanso y atención.', visualProposal: 'Gráfico sencillo de descanso y concentración.', sourceIds: [] },
      { order: 3, durationSeconds: 10, voiceover: 'Una asociación no prueba por sí sola una causa.', visualProposal: 'Cierre con una pregunta para la audiencia.', sourceIds: [] },
    ],
  };
  const aiRouter = {
    priority: () => ['gemini', 'groq', 'ollama'],
    providerSummaries: () => [{
      id: 'ollama', name: 'Ollama', model: 'test-local', configured: true,
      capabilities: ['structured_text'], mayIncurCost: false,
    }],
    checkProviders: async () => [],
    generate: async () => { throw new Error('No se esperaba generación general.'); },
    generateStructured: async ({ validateResponse, prompt }) => {
      proposalCalls += 1;
      return {
        value: validateResponse(prompt.startsWith('Regenera únicamente')
          ? JSON.stringify({ value: '¿Qué cambia cuando descansas bien?' })
          : JSON.stringify(proposal)),
        provider: 'ollama',
        model: 'test-local',
      };
    },
  };
  const server = createApp({
    aiRouter,
    researchFetch,
    researchConfig: { geminiApiKey: 'test-api-key', geminiModel: 'test-search-model', timeoutMs: 1000 },
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const request = (path, options = {}) => fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const input = {
    niche: 'Sueño y concentración',
    audience: 'Público general',
    market: 'México',
    language: 'Español',
    goal: 'Informar',
    format: 'Explicativo',
    durationSeconds: 30,
  };
  try {
    assert.equal(externalSearchCalls, 0);

    const requestId = randomUUID();
    const search = await request('/research', {
      method: 'POST',
      headers: { 'Idempotency-Key': requestId },
      body: JSON.stringify({ ...input, confirmExternalSearch: true }),
    });
    assert.equal(search.status, 201);
    const result = await search.json();
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.result.search, { executed: true, queries: ['calidad del sueño y atención'] });
    assert.equal(result.result.sources.length, 1);
    assert.equal(result.result.sources[0].url, citationUrl);
    assert.equal(result.result.sources[0].publishedAt, null);
    assert.equal(result.result.findings[0].sourceIds[0], result.result.sources[0].id);
    assert.equal(result.result.popularity.status, 'not_measured');

    const repeatedSearch = await request('/research', {
      method: 'POST',
      headers: { 'Idempotency-Key': requestId },
      body: JSON.stringify({ ...input, confirmExternalSearch: true }),
    });
    assert.equal(repeatedSearch.status, 201);
    assert.equal((await repeatedSearch.json()).id, result.id);
    assert.equal(externalSearchCalls, 1);

    const hostedProposalWithoutConsent = await request(`/research/${result.id}/proposal`, {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ provider: 'groq', confirmExternalCost: false }),
    });
    assert.equal(hostedProposalWithoutConsent.status, 400);
    assert.equal(proposalCalls, 0);

    const proposalResponse = await request(`/research/${result.id}/proposal`, {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ provider: 'ollama' }),
    });
    assert.equal(proposalResponse.status, 200);
    const proposalRecord = await proposalResponse.json();
    assert.equal(proposalRecord.proposalStatus, 'draft');
    assert.equal(proposalRecord.proposal.scenes.length, 3);

    const originalScenes = proposalRecord.proposal.scenes;
    const regeneratedHook = await request(`/research/${result.id}/proposal/sections`, {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ provider: 'ollama', section: 'hook' }),
    });
    assert.equal(regeneratedHook.status, 200);
    const regeneratedRecord = await regeneratedHook.json();
    assert.equal(regeneratedRecord.proposal.hook, '¿Qué cambia cuando descansas bien?');
    assert.deepEqual(regeneratedRecord.proposal.scenes, originalScenes);

    const linked = await request(`/research/${result.id}/proposal`, {
      method: 'PUT',
      body: JSON.stringify({ proposal: regeneratedRecord.proposal }),
    });
    assert.equal(linked.status, 200);
    assert.equal((await linked.json()).proposal.title, proposal.title);

    const unapprovedSend = await request(`/research/${result.id}/send-to-media`, { method: 'POST', body: '{}' });
    assert.equal(unapprovedSend.status, 409);

    const approval = await request(`/research/${result.id}/approve`, { method: 'POST', body: '{}' });
    assert.equal((await approval.json()).proposalStatus, 'approved');
    const send = await request(`/research/${result.id}/send-to-media`, { method: 'POST', body: '{}' });
    assert.equal(send.status, 200);
    const sent = await send.json();
    assert.equal(sent.post.status, 'draft');
    assert.equal(sent.research.proposalStatus, 'sent_to_media');
    assert.match(sent.post.source, new RegExp(result.id));

    const duplicateSend = await request(`/research/${result.id}/send-to-media`, { method: 'POST', body: '{}' });
    assert.equal((await duplicateSend.json()).post.id, sent.post.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM posts WHERE source = ?').get(sent.post.source).count, 1);

    const projectResponse = await request('/media/projects', {
      method: 'POST',
      body: JSON.stringify({ postId: sent.post.id, durationSeconds: 30 }),
    });
    assert.equal(projectResponse.status, 201);
    const project = await projectResponse.json();
    assert.equal(project.project.postId, sent.post.id);
    assert.equal(project.project.durationSeconds, proposal.durationSeconds);
    assert.deepEqual(project.project.scenes.map((scene) => scene.order), [0, 1, 2]);
    assert.deepEqual(project.project.scenes.map((scene) => scene.voiceText), proposal.scenes.map((scene) => scene.voiceover));
    assert.deepEqual(project.project.scenes.map((scene) => scene.visualDescription), proposal.scenes.map((scene) => scene.visualProposal));
    assert.ok(project.project.scenes.every((scene) => scene.visualPending));

    const persisted = await request(`/research/${result.id}`);
    assert.equal((await persisted.json()).mediaPostId, sent.post.id);

    const renderWithoutAssets = await request(`/media/projects/${project.project.id}/render`, { method: 'POST', body: '{}' });
    assert.equal(renderWithoutAssets.status, 409);
    assert.match((await renderWithoutAssets.json()).error, /Asigna imágenes o clips/);

    const invalidSourceResponse = await request('/research', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ ...input, niche: 'Tema sin fuentes', confirmExternalSearch: true }),
    });
    assert.equal(invalidSourceResponse.status, 422);
    assert.equal((await invalidSourceResponse.json()).code, 'sources_missing');

    const ungroundedCitation = await request('/research', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ ...input, niche: 'Tema sin búsqueda', confirmExternalSearch: true }),
    });
    assert.equal(ungroundedCitation.status, 422);
    assert.equal((await ungroundedCitation.json()).code, 'search_not_executed');

    const timedOut = await request('/research', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ ...input, niche: 'Tema con demora', confirmExternalSearch: true }),
    });
    assert.equal(timedOut.status, 504);
    assert.equal((await timedOut.json()).code, 'timeout');

  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});
