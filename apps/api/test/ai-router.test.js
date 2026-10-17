import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('provider routing retries safely, fails over, validates JSON, and never exposes keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vyralix-ai-test-'));
  process.env.VYRALIX_DB_PATH = join(directory, 'ai.sqlite');
  const { db, closeDatabase } = await import('../src/db.js');
  const { createProviderRouter } = await import('../src/ai/provider-router.js');
  const { createProviderDefinitions } = await import('../src/ai/providers.js');
  const { ProviderError } = await import('../src/ai/provider-error.js');
  const { parseGeneratedText } = await import('../src/ai/schema.js');

  const clear = () => {
    db.exec('DELETE FROM ai_provider_attempts; DELETE FROM ai_provider_state; DELETE FROM ai_settings; DELETE FROM ai_generations;');
  };
  const runRouter = (router, id) => {
    db.prepare(`INSERT INTO ai_generations (id, request_hash, request_json, status, created_at)
      VALUES (?, 'test-hash', '{}', 'pending', ?)`).run(id, new Date().toISOString());
    return router.generate({ input, generationId: id });
  };
  const responseText = JSON.stringify({
    variants: [{
      title: 'Una curiosidad cotidiana',
      idea: 'Una explicación creativa y original sobre algo común.',
      hook: '¿Sabías que este detalle tiene una explicación?',
      script: 'Observa el detalle. Luego explica por qué ocurre con un ejemplo sencillo y termina con una pregunta.',
      description: 'Descubre esta explicación breve y cuéntanos qué opinas.',
      hashtags: ['curiosidades', 'ideas'],
      format: 'explicativo',
      durationSeconds: 30,
      imageText: '',
      mediaPrompt: '',
      warnings: [],
    }],
  });
  const input = {
    category: 'Curiosidades',
    audience: 'Adultos',
    tone: 'Cercano',
    creativeGoal: 'Explicar algo',
    format: 'libre',
    durationSeconds: 30,
    variants: 1,
    restrictions: '',
    provider: 'auto',
  };
  const provider = (id, generate, check = async () => ({ available: true, modelValid: true, models: ['test-model'] })) => ({
    id, name: id, model: 'test-model', configured: true, missing: [], capabilities: ['structured_text'],
    isPaid: false, mayIncurCost: id !== 'ollama', autoFallbackAllowed: true, generate, check,
  });
  const clock = (() => { let value = 1000; return () => value += 30; })();

  try {
    db.prepare('UPDATE automation_settings SET external_operations_enabled = 1 WHERE id = 1').run();
    let geminiCalls = 0;
    let groqCalls = 0;
    const sleeps = [];
    const fallbackRouter = createProviderRouter({
      database: db,
      providers: [
        provider('gemini', async () => {
          geminiCalls += 1;
          throw new ProviderError('rate_limited', 'limit', { retryable: true, retryAfterSeconds: 32, status: 429 });
        }),
        provider('groq', async () => { groqCalls += 1; return { text: responseText, usage: { inputTokens: 20, outputTokens: 10 } }; }),
        provider('ollama', async () => ({ text: responseText })),
      ],
      sleep: async (duration) => sleeps.push(duration),
      clock,
    });
    const generationId = 'f73bdba8-6f77-4b15-9f83-0f8c7cad6df1';
    const generated = await runRouter(fallbackRouter, generationId);
    assert.equal(generated.provider, 'groq');
    assert.equal(generated.model, 'test-model');
    assert.equal(generated.variants.length, 1);
    assert.equal(generated.fallbackReason, 'rate_limited');
    assert.equal(geminiCalls, 1);
    assert.equal(groqCalls, 1);
    assert.deepEqual(sleeps, []);
    const rateLimitAttempt = db.prepare(`SELECT * FROM ai_provider_attempts
      WHERE generation_id = ? AND provider = 'gemini'`).get(generationId);
    assert.equal(rateLimitAttempt.error_code, 'rate_limited');
    assert.equal(rateLimitAttempt.retry_after_seconds, 32);
    const successAttempt = db.prepare(`SELECT * FROM ai_provider_attempts
      WHERE generation_id = ? AND provider = 'groq'`).get(generationId);
    assert.equal(successAttempt.input_tokens, 20);
    assert.equal(successAttempt.cost_kind, 'unknown');

    clear();
    let transientCalls = 0;
    const retrySleeps = [];
    const transientRouter = createProviderRouter({
      database: db,
      providers: [
        provider('gemini', async () => {
          transientCalls += 1;
          throw new ProviderError('connectivity', 'connection reset', { retryable: true });
        }),
        provider('groq', async () => ({ text: responseText })),
        provider('ollama', async () => ({ text: responseText })),
      ],
      sleep: async (duration) => retrySleeps.push(duration),
      clock,
    });
    const transient = await runRouter(transientRouter, 'f73bdba8-6f77-4b15-9f83-0f8c7cad6df2');
    assert.equal(transient.provider, 'groq');
    assert.equal(transientCalls, 2);
    assert.deepEqual(retrySleeps, [250]);

    clear();
    let timeoutCalls = 0;
    const timeoutRouter = createProviderRouter({
      database: db,
      providers: [provider('gemini', async () => {
        timeoutCalls += 1;
        throw new ProviderError('timeout', 'timed out', { retryable: true });
      })],
      sleep: async () => assert.fail('Timed-out requests must not be retried.'),
      clock,
    });
    await assert.rejects(
      runRouter(timeoutRouter, 'f73bdba8-6f77-4b15-9f83-0f8c7cad6df7'),
      (error) => error.code === 'timeout' && error.failures.length === 1,
    );
    assert.equal(timeoutCalls, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_provider_attempts WHERE error_code = 'timeout'").get().count, 1);

    clear();
    let structuredTimeoutCalls = 0;
    const structuredTimeoutRouter = createProviderRouter({
      database: db,
      providers: [provider('gemini', async () => {
        structuredTimeoutCalls += 1;
        throw new ProviderError('timeout', 'timed out', { retryable: true });
      })],
      sleep: async () => assert.fail('Timed-out planning requests must not be retried.'),
      clock,
    });
    await assert.rejects(
      structuredTimeoutRouter.generateStructured({
        prompt: 'small test prompt',
        provider: 'gemini',
        task: 'media_planning',
      }),
      (error) => error.code === 'timeout' && error.failures.length === 1,
    );
    assert.equal(structuredTimeoutCalls, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_provider_attempts WHERE task = 'media_planning' AND error_code = 'timeout'").get().count, 1);

    clear();
    let invalidStructuredCalls = 0;
    const invalidStructuredRouter = createProviderRouter({
      database: db,
      providers: [provider('gemini', async () => {
        invalidStructuredCalls += 1;
        return { text: 'not json' };
      })],
      sleep: async () => assert.fail('Invalid structured responses must not be retried.'),
      clock,
    });
    await assert.rejects(
      invalidStructuredRouter.generateStructured({
        prompt: 'small test prompt',
        provider: 'gemini',
        task: 'media_planning',
        validateResponse: () => { throw new ProviderError('response_invalid', 'invalid'); },
      }),
      (error) => error.code === 'response_invalid' && error.failures.length === 1,
    );
    assert.equal(invalidStructuredCalls, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_provider_attempts WHERE task = 'media_planning' AND error_code = 'response_invalid'").get().count, 1);

    clear();
    let responseTimeoutCalls = 0;
    const structuredResponseTimeoutRouter = createProviderRouter({
      database: db,
      providers: [provider('gemini', async () => {
        responseTimeoutCalls += 1;
        throw new ProviderError('response_timeout', 'response timed out', { retryable: true, status: 200 });
      })],
      sleep: async () => assert.fail('A response-read timeout must not repeat the provider request.'),
      clock,
    });
    await assert.rejects(
      structuredResponseTimeoutRouter.generateStructured({
        prompt: 'small test prompt',
        provider: 'gemini',
        task: 'media_planning',
      }),
      (error) => error.code === 'response_timeout' && error.failures.length === 1,
    );
    assert.equal(responseTimeoutCalls, 1);

    clear();
    let authCalls = 0;
    const authRouter = createProviderRouter({
      database: db,
      providers: [
        provider('gemini', async () => { authCalls += 1; throw new ProviderError('authentication', 'bad key'); }),
        provider('groq', async () => ({ text: responseText })),
        provider('ollama', async () => ({ text: responseText })),
      ],
      sleep: async () => assert.fail('Auth failures must not retry.'),
      clock,
    });
    const auth = await runRouter(authRouter, 'f73bdba8-6f77-4b15-9f83-0f8c7cad6df3');
    assert.equal(auth.provider, 'groq');
    assert.equal(authCalls, 1);

    clear();
    const invalidRouter = createProviderRouter({
      database: db,
      providers: [
        provider('gemini', async () => ({ text: 'not json' })),
        provider('groq', async () => ({ text: responseText })),
        provider('ollama', async () => ({ text: responseText })),
      ],
      sleep: async () => {},
      clock,
    });
    assert.equal((await runRouter(invalidRouter, 'f73bdba8-6f77-4b15-9f83-0f8c7cad6df4')).provider, 'groq');
    assert.equal(db.prepare("SELECT error_code FROM ai_provider_attempts WHERE provider = 'gemini'").get().error_code, 'response_invalid');
    assert.throws(() => parseGeneratedText('{"variants":[]}', 1), /formato/);
    assert.equal(parseGeneratedText(responseText, 1).variants.length, 1);

    clear();
    const failedRouter = createProviderRouter({
      database: db,
      providers: [
        provider('gemini', async () => { throw new ProviderError('authentication', 'invalid'); }),
        provider('groq', async () => { throw new ProviderError('model_not_found', 'missing'); }),
        provider('ollama', async () => { throw new ProviderError('connectivity', 'offline'); }),
      ],
      sleep: async () => {},
      clock,
    });
    await assert.rejects(
      runRouter(failedRouter, 'f73bdba8-6f77-4b15-9f83-0f8c7cad6df5'),
      (error) => error.code === 'connectivity' && error.failures.length === 3,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_provider_attempts WHERE outcome = 'failed'").get().count, 3);

    clear();
    const unconfigured = createProviderRouter({
      database: db,
      config: {
        geminiApiKey: '', geminiModel: '', groqApiKey: '', groqModel: '',
        ollamaBaseUrl: 'http://127.0.0.1:11434', ollamaModel: '',
      },
    });
    await assert.rejects(unconfigured.generate({ input, generationId: 'f73bdba8-6f77-4b15-9f83-0f8c7cad6df6' }), (error) => error.code === 'no_provider');
    assert.ok(unconfigured.providerSummaries().every((item) => !item.configured && item.availability === 'unknown'));

    const secret = 'test-secret-key-never-returned';
    const mockResponse = (payload, status, headers = {}) => new Response(JSON.stringify(payload), { status, headers });
    const config = {
      geminiApiKey: secret, geminiModel: 'gemini-test', groqApiKey: secret, groqModel: 'groq-test',
      ollamaBaseUrl: 'http://127.0.0.1:11434', ollamaModel: 'local-test', timeoutMs: 1000,
    };
    const geminiOk = createProviderDefinitions(config, {
      fetchImpl: async () => mockResponse({ candidates: [{ content: { parts: [{ text: responseText }] } }] }, 200),
    })[0];
    assert.equal((await geminiOk.generate('prompt')).text, responseText);
    assert.equal(JSON.stringify(geminiOk).includes(secret), false);

    const gemini429 = createProviderDefinitions(config, {
      fetchImpl: async () => mockResponse({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, 429, { 'Retry-After': '7' }),
    })[0];
    await assert.rejects(gemini429.generate('prompt'), (error) => error.code === 'rate_limited' && error.retryAfterSeconds === 7);

    const groqAuth = createProviderDefinitions(config, {
      fetchImpl: async () => mockResponse({ error: { message: 'unauthorized' } }, 401),
    })[1];
    await assert.rejects(groqAuth.generate('prompt'), (error) => error.code === 'authentication' && !error.retryable);

    const groqForbidden = createProviderDefinitions(config, {
      fetchImpl: async () => mockResponse({ error: { message: 'permission denied' } }, 403),
    })[1];
    await assert.rejects(groqForbidden.generate('prompt'), (error) => error.code === 'permission_error' && !error.retryable);

    const modelMissing = createProviderDefinitions(config, {
      fetchImpl: async () => mockResponse({ error: { message: 'not found' } }, 404),
    })[1];
    await assert.rejects(modelMissing.generate('prompt'), (error) => error.code === 'model_not_found');

    const timeoutProvider = createProviderDefinitions(config, {
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    })[0];
    await assert.rejects(timeoutProvider.generate('prompt'), (error) => error.code === 'timeout' && error.retryable);
    const responseTimeoutProvider = createProviderDefinitions({ ...config, timeoutMs: 20 }, {
      fetchImpl: async (_url, options) => {
        const body = new ReadableStream({
          start(controller) {
            options.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
          },
        });
        return new Response(body, { status: 200 });
      },
    })[0];
    await assert.rejects(responseTimeoutProvider.generate('prompt'), (error) =>
      error.code === 'response_timeout' && error.status === 200 && error.retryable);
    const dnsFailure = createProviderDefinitions(config, {
      fetchImpl: async () => {
        throw Object.assign(new Error('fetch failed'), {
          cause: Object.assign(new Error('host unavailable'), { code: 'ENOTFOUND' }),
        });
      },
    })[0];
    await assert.rejects(dnsFailure.generate('prompt'), (error) => error.code === 'dns' && !error.message.includes('host unavailable'));
    const tlsFailure = createProviderDefinitions(config, {
      fetchImpl: async () => {
        throw Object.assign(new Error('fetch failed'), {
          cause: Object.assign(new Error('certificate invalid'), { code: 'CERT_HAS_EXPIRED' }),
        });
      },
    })[0];
    await assert.rejects(tlsFailure.generate('prompt'), (error) => error.code === 'tls' && !error.message.includes('certificate invalid'));
    const unsafeOllama = createProviderDefinitions({ ...config, ollamaBaseUrl: 'http://192.168.1.5:11434' })[2];
    assert.equal(unsafeOllama.configured, false);
    assert.deepEqual(unsafeOllama.missing, ['OLLAMA_BASE_URL']);

    clear();
    db.prepare('UPDATE automation_settings SET external_operations_enabled = 0 WHERE id = 1').run();
    let blockedExternalCalls = 0;
    let localCalls = 0;
    const guardedRouter = createProviderRouter({
      database: db,
      providers: [
        provider('gemini', async () => { blockedExternalCalls += 1; return { text: responseText }; }),
        provider('groq', async () => { blockedExternalCalls += 1; return { text: responseText }; }),
        provider('ollama', async () => { localCalls += 1; return { text: responseText }; }),
      ],
      sleep: async () => assert.fail('La operación bloqueada no debe reintentarse.'),
    });
    await assert.rejects(
      runRouter(guardedRouter, 'f73bdba8-6f77-4b15-9f83-0f8c7cad6df8'),
      (error) => error.code === 'external_operations_disabled' && error.status === 423,
    );
    assert.equal(blockedExternalCalls, 0);
    await assert.rejects(
      guardedRouter.checkProviders(),
      (error) => error.code === 'external_operations_disabled' && error.status === 423,
    );
    assert.equal(blockedExternalCalls, 0);
    await assert.rejects(
      guardedRouter.generateStructured({ prompt: 'test planning prompt', provider: 'gemini' }),
      (error) => error.code === 'external_operations_disabled' && error.status === 423,
    );
    assert.equal(blockedExternalCalls, 0);
    db.prepare(`INSERT INTO ai_generations (id, request_hash, request_json, status, created_at)
      VALUES (?, 'test-hash', '{}', 'pending', ?)`)
      .run('f73bdba8-6f77-4b15-9f83-0f8c7cad6fd8', new Date().toISOString());
    const localResult = await guardedRouter.generate({
      input: { ...input, provider: 'ollama' },
      generationId: 'f73bdba8-6f77-4b15-9f83-0f8c7cad6fd8',
    });
    assert.equal(localResult.provider, 'ollama');
    assert.equal(localCalls, 1);
  } finally {
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
    delete process.env.VYRALIX_DB_PATH;
  }
});
