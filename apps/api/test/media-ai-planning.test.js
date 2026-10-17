import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { ProviderError } from '../src/ai/provider-error.js';
import { validateReviewedSpeech, validateSourceScript } from '../src/media/ai-scene-planner.js';
import { buildSrt } from '../src/media/scene-planner.js';
import { detectFfmpeg, ffmpegPath, ffprobePath } from '../src/media/ffmpeg.js';

const execFileAsync = promisify(execFile);

function plannedScene(order, overrides = {}) {
  return {
    title: `Beat ${order + 1}`,
    narrativeGoal: `Move the story forward in beat ${order + 1}.`,
    durationSeconds: order === 0 ? 6 : 4,
    voiceText: order === 0 ? 'El café revela una idea sencilla.' : 'La idea termina con una conclusión clara.',
    dialogue: '',
    visualDescription: `A vertical close-up shows the main object in the foreground while a hand points toward its defining detail in a warmly lit workshop; the action ends on that detail.`,
    shotType: 'Vertical close-up',
    cameraMovement: 'Slow push-in ending on the object detail.',
    actionDescription: 'A hand enters from frame right, points to the object, then leaves as the camera holds.',
    environment: 'A small, organized workshop with the table centered in frame.',
    lighting: 'Soft warm key light from frame left with subtle cool fill.',
    palette: 'Amber, charcoal, and muted teal.',
    continuityBefore: order === 0 ? 'Opening state: the object rests centered on the workshop table.' : 'Keep the same object and workshop table from the previous beat.',
    continuityAfter: order === 0 ? 'Hold on the highlighted detail to lead into its explanation.' : 'End on the object in the same position for the conclusion.',
    onScreenText: '',
    subtitleText: order === 0 ? 'El café conserva una historia.' : 'La explicación está en los detalles.',
    transition: order === 0 ? 'cut' : 'fade',
    audioNotes: 'Low workshop ambience under a clear voice.',
    ...overrides,
  };
}

function planResponse() {
  return JSON.stringify({
    narrativeGoal: 'Explain one visual detail and close with a concise takeaway.',
    scenes: [plannedScene(0), plannedScene(1)],
  });
}

function regeneratedResponse() {
  return JSON.stringify({
    scene: plannedScene(0, {
      title: 'A closer look',
      narrativeGoal: 'Reveal the detail that introduces the explanation.',
      voiceText: 'El café cambia de aroma con el tiempo.',
      subtitleText: 'El café cambia de aroma.',
      visualDescription: 'A vertical macro shot frames the coffee beans at center while a hand gently turns one bean; the camera ends on its textured surface.',
      actionDescription: 'A hand turns one bean between two fingers, then pauses to show its surface.',
      continuityBefore: 'Begin with the same beans and amber workshop light as the opening composition.',
      continuityAfter: 'Hold on the bean texture to connect to the explanation in the next scene.',
    }),
  });
}

test('Media Studio genera, revisa, cancela, persiste y renderiza un plan IA aislado', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vyralix-media-ai-plan-'));
  const originalDatabasePath = process.env.VYRALIX_DB_PATH;
  process.env.VYRALIX_DB_PATH = join(directory, 'media-plan.sqlite');
  const { db, dbPath, closeDatabase } = await import('../src/db.js');
  db.prepare('UPDATE automation_settings SET external_operations_enabled = 1 WHERE id = 1').run();
  const { createProviderRouter } = await import('../src/ai/provider-router.js');
  const { createApp } = await import('../src/app.js');
  const responses = [];
  let activeResponse;
  let signalStarted;
  let resolveStarted;
  const waitUntilAborted = (signal) => new Promise((_, reject) => {
    if (signal.aborted) return reject(new ProviderError('cancelled', 'cancelled'));
    signal.addEventListener('abort', () => reject(new ProviderError('cancelled', 'cancelled')), { once: true });
  });
  const provider = {
    id: 'ollama',
    name: 'Ollama local',
    model: 'mock-local-model',
    configured: true,
    missing: [],
    capabilities: ['structured_text'],
    autoFallbackAllowed: true,
    mayIncurCost: false,
    isPaid: false,
    async generate(_prompt, { signal } = {}) {
      if (activeResponse === 'wait') {
        resolveStarted();
        return waitUntilAborted(signal);
      }
      const next = responses.shift();
      if (typeof next === 'function') return next();
      return { text: next };
    },
  };
  const router = createProviderRouter({ database: db, providers: [provider], sleep: async () => {} });
  let restrictedFallbackCalls = 0;
  const restrictedRouter = createProviderRouter({
    database: db,
    providers: [
      { ...provider, id: 'gemini', model: 'mock-gemini', autoFallbackAllowed: false, async generate() {
        throw new ProviderError('timeout', 'timeout', { retryable: true });
      } },
      { ...provider, id: 'groq', model: 'mock-groq', autoFallbackAllowed: false, async generate() {
        restrictedFallbackCalls += 1;
        return { text: 'should not run' };
      } },
    ],
    sleep: async () => {},
  });
  await assert.rejects(
    restrictedRouter.generateStructured({ prompt: 'test', provider: 'auto', task: 'fallback_policy_test' }),
    (error) => error.code === 'timeout',
  );
  assert.equal(restrictedFallbackCalls, 0);
  let allowedFallbackCalls = 0;
  const allowedRouter = createProviderRouter({
    database: db,
    providers: [
      { ...provider, id: 'gemini', model: 'mock-gemini', autoFallbackAllowed: true, async generate() {
        throw new ProviderError('authentication', 'auth');
      } },
      { ...provider, id: 'groq', model: 'mock-groq', async generate() {
        allowedFallbackCalls += 1;
        return { text: 'fallback accepted' };
      } },
    ],
    sleep: async () => {},
  });
  const structuredFallback = await allowedRouter.generateStructured({
    prompt: 'test',
    provider: 'auto',
    task: 'fallback_policy_test',
  });
  assert.equal(structuredFallback.provider, 'groq');
  assert.equal(allowedFallbackCalls, 1);
  const app = createApp({ aiRouter: router });
  const service = app.locals.mediaService;
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const origin = `http://127.0.0.1:${server.address().port}/api/v1`;
  const json = async (path, options = {}) => {
    const response = await fetch(`${origin}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  };
  const settings = {
    durationSeconds: 10,
    sceneCount: 2,
    platform: 'TikTok',
    visualStyle: 'Cinematic workshop close-ups',
    tone: 'Clear and friendly',
    editingPace: 'balanced',
    audience: 'Adults interested in everyday curiosities',
    speechMode: 'narration',
    language: 'Spanish',
    provider: 'ollama',
  };

  try {
    const postResult = await json('/posts', {
      method: 'POST',
      body: JSON.stringify({
        title: 'AI scene plan test',
        category: 'Curiosities',
        body: 'El café cuenta una historia sencilla sobre el aroma y el paso del tiempo.',
      }),
    });
    assert.equal(postResult.response.status, 201);
    const projectResult = await json('/media/projects', {
      method: 'POST',
      body: JSON.stringify({ postId: postResult.body.id, durationSeconds: 10 }),
    });
    assert.equal(projectResult.response.status, 201);
    const projectId = projectResult.body.project.id;
    const originalScenes = projectResult.body.project.scenes;
    assert.ok(originalScenes.length > 0);

    responses.push(planResponse());
    const previewResult = await json(`/media/projects/${projectId}/plan`, {
      method: 'POST',
      body: JSON.stringify({ settings }),
    });
    assert.equal(previewResult.response.status, 200, previewResult.body.error);
    assert.equal(previewResult.body.provider, 'ollama');
    assert.equal(previewResult.body.attempts, 1);
    assert.equal(previewResult.body.plan.scenes.length, 2);
    assert.equal(previewResult.body.plan.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), 10);
    assert.equal(previewResult.body.plan.scenes[0].order, 0);
    assert.ok(previewResult.body.plan.scenes.every((scene) => scene.id && scene.visualDescription.length >= 20));
    let persisted = await json(`/media/projects/${projectId}`);
    assert.equal(persisted.body.scenes.length, originalScenes.length);
    assert.equal(persisted.body.aiPlan, null);

    responses.push(regeneratedResponse());
    const regenerateResult = await json(`/media/projects/${projectId}/plan/scenes/0/regenerate`, {
      method: 'POST',
      body: JSON.stringify({ settings, plan: previewResult.body.plan }),
    });
    assert.equal(regenerateResult.response.status, 200, regenerateResult.body.error);
    assert.equal(regenerateResult.body.scene.id, previewResult.body.plan.scenes[0].id);
    assert.equal(regenerateResult.body.scene.durationSeconds, previewResult.body.plan.scenes[0].durationSeconds);
    const reviewedPlan = {
      ...previewResult.body.plan,
      scenes: [regenerateResult.body.scene, previewResult.body.plan.scenes[1]],
    };
    assert.equal(reviewedPlan.scenes[1].title, previewResult.body.plan.scenes[1].title);

    responses.push('{', '{"narrativeGoal":"incomplete","scenes":[]}');
    const invalidResult = await json(`/media/projects/${projectId}/plan`, {
      method: 'POST',
      body: JSON.stringify({ settings }),
    });
    assert.equal(invalidResult.response.status, 502);
    assert.match(invalidResult.body.error, /inválida|incompleta/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_provider_attempts WHERE task = 'media_planning' AND error_code = 'response_invalid'").get().count, 1);
    persisted = await json(`/media/projects/${projectId}`);
    assert.equal(persisted.body.aiPlan, null);
    assert.equal(persisted.body.scenes.length, originalScenes.length);

    activeResponse = 'wait';
    const controller = new AbortController();
    const pending = fetch(`${origin}/media/projects/${projectId}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
      signal: controller.signal,
    });
    await new Promise((resolve) => { resolveStarted = resolve; });
    controller.abort();
    await assert.rejects(pending, (error) => error.name === 'AbortError');
    activeResponse = null;
    persisted = await json(`/media/projects/${projectId}`);
    assert.equal(persisted.body.aiPlan, null);
    assert.equal(persisted.body.scenes.length, originalScenes.length);

    const invalidReviewedPlan = {
      ...reviewedPlan,
      scenes: reviewedPlan.scenes.map((scene, index) => index === 1 ? { ...scene, dialogue: 'Una intervención adicional.' } : scene),
    };
    const rejectedPlan = await json(`/media/projects/${projectId}/plan`, {
      method: 'PUT',
      body: JSON.stringify({
        settings,
        plan: invalidReviewedPlan,
        provider: 'ollama',
        model: 'mock-local-model',
        preserveAssets: false,
      }),
    });
    assert.equal(rejectedPlan.response.status, 502);
    assert.equal(rejectedPlan.body.code, 'response_invalid');
    persisted = await json(`/media/projects/${projectId}`);
    assert.equal(persisted.body.aiPlan, null);
    assert.equal(persisted.body.scenes.length, originalScenes.length);

    const applyResult = await json(`/media/projects/${projectId}/plan`, {
      method: 'PUT',
      body: JSON.stringify({
        settings,
        plan: reviewedPlan,
        provider: 'ollama',
        model: 'mock-local-model',
        preserveAssets: false,
      }),
    });
    assert.equal(applyResult.response.status, 200, applyResult.body.error);
    const approvedProject = applyResult.body.project;
    assert.equal(approvedProject.aiPlan.provider, 'ollama');
    assert.equal(approvedProject.aiPlan.model, 'mock-local-model');
    assert.equal(approvedProject.scenes.length, 2);
    assert.ok(approvedProject.scenes.every((scene) => scene.visualPending && scene.asset === null));
    assert.equal(approvedProject.scenes[0].title, 'A closer look');
    assert.match(buildSrt([{
      subtitleText: 'El café conserva su aroma.',
      onScreenText: '',
      durationSeconds: 5,
    }]), /El café conserva su aroma/u);
    assert.ok(db.prepare('SELECT 1 FROM media_scene_details WHERE scene_id = ?').get(approvedProject.scenes[0].id));
    const blockedRender = await json(`/media/projects/${projectId}/render`, { method: 'POST', body: '{}' });
    assert.equal(blockedRender.response.status, 409);
    assert.match(blockedRender.body.error, /pendientes de material visual/i);

    const ffmpeg = await detectFfmpeg();
    await t.test('Las escenas aprobadas continúan por el render real y FFprobe confirma la exportación', {
      skip: !ffmpeg.ffmpeg.available || !ffmpeg.ffprobe.available,
    }, async () => {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pN8AAAAASUVORK5CYII=', 'base64');
      const uploaded = await fetch(`${origin}/media/assets`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Media-Filename': 'synthetic-local.png',
          'X-Media-Provenance': encodeURIComponent('Synthetic integration test image'),
          'X-Media-License': encodeURIComponent('Created for isolated local test'),
        },
        body: png,
      });
      const assetResult = await uploaded.json();
      assert.equal(uploaded.status, 201, assetResult.error);
      for (const scene of approvedProject.scenes) {
        const assigned = await json(`/media/scenes/${scene.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ assetId: assetResult.asset.id, visualType: 'image' }),
        });
        assert.equal(assigned.response.status, 200, assigned.body.error);
      }
      const started = await json(`/media/projects/${projectId}/render`, { method: 'POST', body: '{}' });
      assert.equal(started.response.status, 202, started.body.error);
      const jobId = started.body.job.id;
      const deadline = Date.now() + 120_000;
      let job;
      while (Date.now() < deadline) {
        const current = await json(`/media/jobs/${jobId}`);
        assert.equal(current.response.status, 200);
        job = current.body;
        if (['completed', 'failed', 'cancelled'].includes(job.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.equal(job.status, 'completed', job.error || job.stage);
      assert.match(job.stage, /revisión visual pendiente/u);
      const exportList = await json('/media/exports');
      const exported = exportList.body.find((item) => item.projectId === projectId);
      assert.ok(exported);
      assert.equal(exported.technicalValidationStatus, 'ffprobe_passed');
      assert.equal(exported.visualReviewStatus, 'pending');
      assert.equal(exported.visualReviewedAt, null);
      assert.equal((await json(`/media/exports/${exported.id}/visual-review`, {
        method: 'POST',
        body: JSON.stringify({ status: 'not-a-review' }),
      })).response.status, 400);
      const approvedReview = await json(`/media/exports/${exported.id}/visual-review`, {
        method: 'POST',
        body: JSON.stringify({ status: 'approved', note: 'Inspección manual de la exportación aislada.' }),
      });
      assert.equal(approvedReview.response.status, 200, approvedReview.body.error);
      assert.equal(approvedReview.body.export.visualReviewStatus, 'approved');
      assert.ok(approvedReview.body.export.visualReviewedAt);
      assert.equal(approvedReview.body.export.visualReviewNote, 'Inspección manual de la exportación aislada.');
      const needsChangesReview = await json(`/media/exports/${exported.id}/visual-review`, {
        method: 'POST',
        body: JSON.stringify({ status: 'needs_changes' }),
      });
      assert.equal(needsChangesReview.response.status, 200, needsChangesReview.body.error);
      assert.equal(needsChangesReview.body.export.visualReviewStatus, 'needs_changes');
      assert.equal(needsChangesReview.body.export.visualReviewNote, null);
      const reapprovedReview = await json(`/media/exports/${exported.id}/visual-review`, {
        method: 'POST',
        body: JSON.stringify({ status: 'approved' }),
      });
      assert.equal(reapprovedReview.response.status, 200, reapprovedReview.body.error);
      assert.equal(reapprovedReview.body.export.visualReviewStatus, 'approved');
      const mp4Path = join(dirname(dbPath), 'media', 'exports', `${jobId}.mp4`);
      const probeResult = await execFileAsync(ffprobePath(), [
        '-v', 'error', '-show_entries', 'format=format_name,duration,size:stream=codec_type,codec_name,width,height',
        '-of', 'json', mp4Path,
      ], { timeout: 20_000, windowsHide: true });
      const metadata = JSON.parse(probeResult.stdout);
      const video = metadata.streams.find((stream) => stream.codec_type === 'video');
      assert.ok(String(metadata.format.format_name).split(',').includes('mp4'));
      assert.equal(video.width, 720);
      assert.equal(video.height, 1280);
      assert.ok(Number(metadata.format.duration) > 0);
      assert.equal(exported.videoCodec, 'h264');
      const saved = await json(`/media/projects/${projectId}`);
      assert.ok(saved.body.scenes.every((scene) => !scene.visualPending && scene.asset));

      const secondRender = await json(`/media/projects/${projectId}/render`, { method: 'POST', body: '{}' });
      assert.equal(secondRender.response.status, 202, secondRender.body.error);
      const secondJobId = secondRender.body.job.id;
      const secondDeadline = Date.now() + 120_000;
      let secondJob;
      while (Date.now() < secondDeadline) {
        const current = await json(`/media/jobs/${secondJobId}`);
        assert.equal(current.response.status, 200);
        secondJob = current.body;
        if (['completed', 'failed', 'cancelled'].includes(secondJob.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.equal(secondJob.status, 'completed', secondJob.error || secondJob.stage);
      const exportsAfterSecondRender = (await json('/media/exports')).body.filter((item) => item.projectId === projectId);
      assert.equal(exportsAfterSecondRender.length, 2);
      assert.equal(exportsAfterSecondRender.find((item) => item.id === exported.id).visualReviewStatus, 'approved');
      const newExport = exportsAfterSecondRender.find((item) => item.id !== exported.id);
      assert.equal(newExport.visualReviewStatus, 'pending');
    });
  } finally {
    await service.shutdown();
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
    if (originalDatabasePath === undefined) delete process.env.VYRALIX_DB_PATH;
    else process.env.VYRALIX_DB_PATH = originalDatabasePath;
  }
});

test('El esquema de planificación limita escenas y conserva subtítulos Unicode', () => {
  assert.match(buildSrt([{ subtitleText: 'acción, café y narración', onScreenText: '', durationSeconds: 3 }]), /acción, café y narración/u);
});

test('La validación de guion largo y modo de habla rechaza planes incompatibles', () => {
  const settings = { durationSeconds: 10, editingPace: 'slow', speechMode: 'both' };
  assert.throws(
    () => validateSourceScript({ sourceScript: Array(50).fill('palabra').join(' ') }, settings),
    (error) => error.code === 'script_too_long',
  );
  assert.throws(
    () => validateReviewedSpeech({ scenes: [plannedScene(0), plannedScene(1)] }, settings),
    (error) => error.code === 'response_invalid',
  );
});
