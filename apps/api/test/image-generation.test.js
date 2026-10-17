import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createImageGenerationService } from '../src/media/image-generation.js';

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createPng() {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const data = deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', data),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function imageRequest(prompt = 'Una imagen editorial original') {
  return {
    provider: 'gemini',
    model: 'gemini-nano-banana-2.1',
    prompt,
    confirmCost: true,
  };
}

test('image generation remains unavailable without an explicit image model and never calls a provider', async () => {
  let calls = 0;
  const service = createImageGenerationService({
    mediaService: { saveGeneratedImage: async () => assert.fail('No image should be saved.') },
    apiKey: 'test-only-key',
    model: '',
    fetchImpl: async () => { calls += 1; throw new Error('External provider must not be called.'); },
  });
  assert.equal(service.settings().enabled, false);
  assert.ok(service.settings().missing.includes('GEMINI_IMAGE_MODEL'));
  await assert.rejects(service.generate(imageRequest(), randomUUID()), { code: 'not_configured', status: 503 });
  assert.equal(calls, 0);
});

test('image generation validates model, prompt, explicit cost confirmation, and provider output', async () => {
  let calls = 0;
  const service = createImageGenerationService({
    mediaService: { saveGeneratedImage: async () => ({ asset: { id: randomUUID() }, duplicate: false }) },
    apiKey: 'test-only-key',
    model: 'gemini-nano-banana-2.1',
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ output_image: { data: Buffer.from('not a png').toString('base64'), mime_type: 'image/png' } }), { status: 200 });
    },
  });
  await assert.rejects(service.generate({ ...imageRequest(), confirmCost: false }, randomUUID()), { code: 'invalid_request', status: 400 });
  await assert.rejects(service.generate({ ...imageRequest(), provider: 'groq' }, randomUUID()), { code: 'unsupported_provider', status: 400 });
  await assert.rejects(service.generate({ ...imageRequest(), model: 'gemini-3.8-flash' }, randomUUID()), { code: 'unsupported_model', status: 400 });
  await assert.rejects(service.generate(imageRequest('no'), randomUUID()), { code: 'invalid_request', status: 400 });
  await assert.rejects(service.generate(imageRequest(), randomUUID()), { code: 'invalid_image' });
  assert.equal(calls, 1);
});

test('global external-operation lock prevents image providers from being called', async () => {
  let calls = 0;
  const service = createImageGenerationService({
    mediaService: { saveGeneratedImage: async () => assert.fail('A blocked image must not be saved.') },
    apiKey: 'test-only-key',
    model: 'gemini-nano-banana-2.1',
    fetchImpl: async () => { calls += 1; throw new Error('External provider must not be called.'); },
    assertExternalOperationsEnabled: () => {
      throw Object.assign(new Error('Las operaciones externas están desactivadas.'), {
        code: 'external_operations_disabled',
        status: 423,
      });
    },
  });
  await assert.rejects(service.generate(imageRequest(), randomUUID()), {
    code: 'external_operations_disabled',
    status: 423,
  });
  assert.equal(calls, 0);
});

test('image provider adapter contract uses the explicitly selected compatible provider and model', async () => {
  const image = createPng();
  let selectedPrompt = '';
  const provider = {
    id: 'test-image-provider',
    name: 'Test image provider',
    model: 'test-image-v1',
    models: [{ id: 'test-image-v1', name: 'Test model' }],
    configured: true,
    missing: [],
    mayIncurCost: false,
    async generate(prompt) {
      selectedPrompt = prompt;
      return { buffer: image, model: this.model };
    },
  };
  const service = createImageGenerationService({
    mediaService: { saveGeneratedImage: async () => ({ asset: { id: randomUUID() }, duplicate: false }) },
    providers: [provider],
  });
  const generated = await service.generate({
    provider: provider.id,
    model: provider.model,
    prompt: 'Prueba de interfaz común de proveedor',
    confirmCost: true,
  }, randomUUID());
  assert.equal(generated.provider, provider.id);
  assert.equal(generated.model, provider.model);
  assert.equal(selectedPrompt, 'Prueba de interfaz común de proveedor');
});

test('image generation supports cancellation, timeouts, and safe provider errors', async () => {
  const mediaService = { saveGeneratedImage: async () => assert.fail('No image should be saved.') };
  const cancellationService = createImageGenerationService({
    mediaService,
    apiKey: 'test-only-key',
    model: 'gemini-nano-banana-2.1',
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  const controller = new AbortController();
  const cancelled = cancellationService.generate(imageRequest(), randomUUID(), controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(cancelled, { code: 'cancelled', status: 499 });

  const timeoutService = createImageGenerationService({
    mediaService,
    apiKey: 'test-only-key',
    model: 'gemini-nano-banana-2.1',
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  await assert.rejects(timeoutService.generate(imageRequest(), randomUUID()), { code: 'timeout', status: 504 });

  const quotaService = createImageGenerationService({
    mediaService,
    apiKey: 'test-only-key',
    model: 'gemini-nano-banana-2.1',
    fetchImpl: async () => new Response('{"error":{"message":"private provider detail"}}', { status: 429 }),
  });
  await assert.rejects(quotaService.generate(imageRequest(), randomUUID()), (error) => {
    assert.equal(error.code, 'rate_limited');
    assert.equal(error.status, 429);
    assert.doesNotMatch(error.message, /private provider detail/);
    return true;
  });
});

test('mocked Gemini response saves to the existing media library and assigns persistently to a scene', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vyralix-image-integration-'));
  const environment = {
    dbPath: process.env.VYRALIX_DB_PATH,
    apiKey: process.env.GEMINI_API_KEY,
    imageModel: process.env.GEMINI_IMAGE_MODEL,
    ffmpeg: process.env.FFMPEG_PATH,
    ffprobe: process.env.FFPROBE_PATH,
  };
  process.env.VYRALIX_DB_PATH = join(directory, 'vyralix.sqlite');
  process.env.GEMINI_API_KEY = 'test-only-key';
  process.env.GEMINI_IMAGE_MODEL = 'gemini-nano-banana-2.1';
  process.env.FFMPEG_PATH = join(directory, 'missing-ffmpeg.exe');
  process.env.FFPROBE_PATH = join(directory, 'missing-ffprobe.exe');
  const image = createPng();
  let providerCalls = 0;
  let requestBody;
  let imageAuthorizationConsumed = false;
  const fetchImpl = async (url, options) => {
    providerCalls += 1;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(options.headers['x-goog-api-key'], 'test-only-key');
    requestBody = JSON.parse(options.body);
    assert.equal(requestBody.store, false);
    return new Response(JSON.stringify({
      output_image: { data: image.toString('base64'), mime_type: 'image/png' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const { createApp } = await import('../src/app.js');
  const { closeDatabase, db } = await import('../src/db.js');
  const app = createApp({
    imageGenerationFetch: fetchImpl,
    imageGenerationAuthorization: ({ provider, model, prompt, requestId }) => {
      assert.equal(requestId.length, 36);
      if (imageAuthorizationConsumed || provider !== 'gemini' ||
        model !== 'gemini-nano-banana-2.1' || prompt !== 'Una imagen editorial original') {
        throw Object.assign(new Error('Autorización de imagen de una sola solicitud agotada o no coincidente.'), {
          status: 423, code: 'external_operations_disabled',
        });
      }
      imageAuthorizationConsumed = true;
    },
  });
  let server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const json = (path, options = {}) => fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  try {
    const capabilities = await (await json('/media/image-generations/capabilities')).json();
    assert.equal(capabilities.enabled, true);
    assert.equal(capabilities.model, 'gemini-nano-banana-2.1');
    assert.equal(capabilities.mayIncurCost, true);
    assert.equal(app.locals.automationService.settings().externalOperationsEnabled, false);

    const requestId = randomUUID();
    const generated = await json('/media/image-generations', {
      method: 'POST',
      headers: { 'Idempotency-Key': requestId },
      body: JSON.stringify(imageRequest()),
    });
    assert.equal(generated.status, 201, await generated.clone().text());
    const preview = await generated.json();
    assert.equal(preview.id, requestId);
    assert.equal(preview.model, requestBody.model);
    assert.deepEqual(requestBody.input, [{ type: 'text', text: 'Una imagen editorial original' }]);
    assert.equal(providerCalls, 1);
    const unauthorizedSecondImage = await json('/media/image-generations', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(imageRequest()),
    });
    assert.equal(unauthorizedSecondImage.status, 423);
    assert.equal(providerCalls, 1);
    const replay = await json('/media/image-generations', {
      method: 'POST',
      headers: { 'Idempotency-Key': requestId },
      body: JSON.stringify(imageRequest()),
    });
    assert.equal(replay.status, 201);
    assert.equal((await replay.json()).id, requestId);
    assert.equal(providerCalls, 1);
    const unauthorizedResearch = await json('/research', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({
        niche: 'Tema de prueba', audience: 'Adultos', market: 'México', language: 'Español',
        goal: 'Informar', format: 'Explicativo', durationSeconds: 30, confirmExternalSearch: true,
      }),
    });
    assert.equal(unauthorizedResearch.status, 423);
    assert.equal(providerCalls, 1);
    assert.equal(app.locals.automationService.settings().externalOperationsEnabled, false);

    const previewResponse = await json(preview.contentUrl);
    assert.equal(previewResponse.status, 200);
    assert.equal(previewResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await previewResponse.arrayBuffer()), image);

    const saved = await json(`/media/image-generations/${requestId}/save`, { method: 'POST', body: '{}' });
    assert.equal(saved.status, 201);
    const { asset } = await saved.json();
    assert.equal(asset.kind, 'image');
    assert.equal(asset.provenance, 'Generada mediante Gemini · Google');
    assert.equal(asset.missing, false);
    assert.doesNotMatch(JSON.stringify(asset), /Una imagen editorial original/u);

    const repeatedSave = await json(`/media/image-generations/${requestId}/save`, { method: 'POST', body: '{}' });
    assert.equal(repeatedSave.status, 200);
    assert.equal((await repeatedSave.json()).asset.id, asset.id);
    const library = await json('/media/assets?kind=image');
    assert.ok((await library.json()).some((item) => item.id === asset.id));

    const postResponse = await json('/posts', {
      method: 'POST',
      body: JSON.stringify({ title: 'Prueba integración de imagen', category: 'Pruebas', body: 'Guion de prueba.' }),
    });
    const post = await postResponse.json();
    const projectResponse = await json('/media/projects', {
      method: 'POST',
      body: JSON.stringify({ postId: post.id, durationSeconds: 5 }),
    });
    const project = (await projectResponse.json()).project;
    const assigned = await json(`/media/scenes/${project.scenes[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({ assetId: asset.id, visualType: 'image' }),
    });
    assert.equal(assigned.status, 200, await assigned.clone().text());
    const reloaded = await json(`/media/projects/${project.id}`);
    assert.equal((await reloaded.json()).scenes[0].asset.id, asset.id);
    assert.equal(providerCalls, 1);

    await new Promise((resolve) => server.close(resolve));
    server = null;
    closeDatabase();
    const persistedDatabase = new Database(join(directory, 'vyralix.sqlite'), { readonly: true });
    try {
      const persistedAsset = persistedDatabase.prepare('SELECT relative_path FROM media_assets WHERE id = ?').get(asset.id);
      assert.ok(persistedAsset);
      assert.deepEqual(await readFile(join(directory, 'media', persistedAsset.relative_path)), image);
      const persistedScene = persistedDatabase.prepare('SELECT asset_id FROM media_scenes WHERE id = ?').get(project.scenes[0].id);
      assert.equal(persistedScene.asset_id, asset.id);
    } finally {
      persistedDatabase.close();
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    for (const [key, value] of Object.entries({
      VYRALIX_DB_PATH: environment.dbPath,
      GEMINI_API_KEY: environment.apiKey,
      GEMINI_IMAGE_MODEL: environment.imageModel,
      FFMPEG_PATH: environment.ffmpeg,
      FFPROBE_PATH: environment.ffprobe,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
