import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

function testWave(durationSeconds = 1.25) {
  const sampleRate = 22_050;
  const sampleCount = Math.round(sampleRate * durationSeconds);
  const dataBytes = sampleCount * 2;
  const wave = Buffer.alloc(44 + dataBytes);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(36 + dataBytes, 4);
  wave.write('WAVE', 8);
  wave.write('fmt ', 12);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    wave.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 5_000), 44 + index * 2);
  }
  return wave;
}

test('Media Studio genera, valida, conserva y renderiza voces locales por escena', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vyralix-media-voice-'));
  const originalDatabasePath = process.env.VYRALIX_DB_PATH;
  process.env.VYRALIX_DB_PATH = join(directory, 'media-voice.sqlite');
  const { db, dbPath, closeDatabase } = await import('../src/db.js');
  const { detectFfmpeg, ffprobePath } = await import('../src/media/ffmpeg.js');
  const { createApp } = await import('../src/app.js');
  const engineState = { mode: 'normal', start: null, durationSeconds: 1.25 };
  const voiceEngine = {
    id: 'windows_sapi',
    async listVoices() {
      return [{ id: 'Mock Spanish Voice', name: 'Mock Spanish Voice', language: 'es-MX', gender: 'Female' }];
    },
    async synthesize({ outputPath, signal }) {
      if (engineState.mode === 'error') throw Object.assign(new Error('provider failure'), { code: 'tts_generation_failed' });
      if (engineState.mode === 'timeout') throw Object.assign(new Error('timeout'), { code: 'tts_timeout' });
      if (engineState.mode === 'invalid') return writeFile(outputPath, Buffer.from('not a wav file'));
      if (engineState.mode === 'wait') {
        engineState.start?.();
        await new Promise((resolve, reject) => {
          if (signal.aborted) return reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
          signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })), { once: true });
        });
      }
      await writeFile(outputPath, testWave(engineState.durationSeconds));
    },
  };
  const app = createApp({ voiceEngine });
  const noVoiceApp = createApp({
    voiceEngine: { id: 'windows_sapi', async listVoices() { return []; }, async synthesize() { assert.fail('No voice should run when none is installed.'); } },
  });
  const server = app.listen(0, '127.0.0.1');
  const noVoiceServer = noVoiceApp.listen(0, '127.0.0.1');
  await Promise.all([
    new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); }),
    new Promise((resolve, reject) => { noVoiceServer.once('listening', resolve); noVoiceServer.once('error', reject); }),
  ]);
  const origin = `http://127.0.0.1:${server.address().port}/api/v1`;
  const noVoiceOrigin = `http://127.0.0.1:${noVoiceServer.address().port}/api/v1`;
  const json = async (base, path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  };
  const createProject = async (title, body) => {
    const post = await json(origin, '/posts', {
      method: 'POST',
      body: JSON.stringify({ title, category: 'Test', body }),
    });
    assert.equal(post.response.status, 201);
    const project = await json(origin, '/media/projects', {
      method: 'POST',
      body: JSON.stringify({ postId: post.body.id, durationSeconds: 5 }),
    });
    assert.equal(project.response.status, 201);
    return project.body.project;
  };
  const settings = { voiceId: 'Mock Spanish Voice', rate: 0, volume: 100 };
  const startVoice = (base, projectId, sceneId, input = settings) => json(base, `/media/projects/${projectId}/scenes/${sceneId}/voice`, {
    method: 'POST', body: JSON.stringify(input),
  });
  const waitForGeneration = async (id) => {
    const deadline = Date.now() + 20_000;
    let result;
    do {
      result = await json(origin, `/media/voice-generations/${id}`);
      assert.equal(result.response.status, 200, result.body.error);
      if (!['queued', 'processing'].includes(result.body.generation.status)) return result.body.generation;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.fail('Voice generation did not finish before the timeout.');
  };
  const ffmpeg = await detectFfmpeg();

  try {
    if (!ffmpeg.ffprobe.available) {
      t.skip('FFprobe is required to validate actual voice files.');
      return;
    }
    const diagnostic = await json(origin, '/media/diagnostics');
    assert.equal(diagnostic.response.status, 200);
    const sapiProvider = diagnostic.body.voiceProviders.find((provider) => provider.id === 'windows_sapi');
    assert.equal(sapiProvider.available, true);
    assert.equal(sapiProvider.voices[0].language, 'es-MX');

    const project = await createProject('Voice test', 'Hola, esta es una narración local para verificar el audio.');
    const scene = project.scenes[0];
    assert.ok(scene.voiceText.length > 0);

    const noVoiceProject = await createProject('No installed voice', 'Una frase para probar voces.');
    const unavailable = await startVoice(noVoiceOrigin, noVoiceProject.id, noVoiceProject.scenes[0].id);
    assert.equal(unavailable.response.status, 503);
    const wrongProject = await startVoice(origin, project.id, noVoiceProject.scenes[0].id);
    assert.equal(wrongProject.response.status, 404);
    const invalidSettings = await startVoice(origin, project.id, scene.id, { ...settings, rate: 6 });
    assert.equal(invalidSettings.response.status, 400);

    const textBefore = db.prepare('SELECT voice_text FROM media_scenes WHERE id = ?').get(scene.id).voice_text;
    db.prepare('UPDATE media_scenes SET voice_text = ? WHERE id = ?').run('', scene.id);
    const empty = await startVoice(origin, project.id, scene.id);
    assert.equal(empty.response.status, 422);
    db.prepare('UPDATE media_scenes SET voice_text = ? WHERE id = ?').run(textBefore, scene.id);
    db.prepare('UPDATE media_scenes SET voice_text = ? WHERE id = ?').run('x'.repeat(3001), scene.id);
    const tooLong = await startVoice(origin, project.id, scene.id);
    assert.equal(tooLong.response.status, 422);
    db.prepare('UPDATE media_scenes SET voice_text = ? WHERE id = ?').run(textBefore, scene.id);

    const first = await startVoice(origin, project.id, scene.id);
    assert.equal(first.response.status, 202, first.body.error);
    const firstVoice = await waitForGeneration(first.body.generation.id);
    assert.equal(firstVoice.status, 'completed');
    assert.equal(firstVoice.active, true);
    assert.equal(firstVoice.language, 'es-MX');
    assert.ok(firstVoice.durationSeconds > 1);
    assert.equal(firstVoice.format, 'wav');
    const audioResponse = await fetch(`${origin}/media/voice-generations/${firstVoice.id}/file`);
    assert.equal(audioResponse.status, 200);
    assert.equal(audioResponse.headers.get('content-type'), 'audio/wav');
    assert.ok((await audioResponse.arrayBuffer()).byteLength > 44);
    const savedProject = await json(origin, `/media/projects/${project.id}`);
    assert.equal(savedProject.body.scenes[0].voiceAudio.id, firstVoice.id);
    assert.equal(savedProject.body.scenes[0].voiceAudio.stale, false);
    const firstRow = db.prepare('SELECT relative_path FROM media_scene_voice_generations WHERE id = ?').get(firstVoice.id);
    db.prepare('UPDATE media_scene_voice_generations SET relative_path = ? WHERE id = ?').run('../outside.wav', firstVoice.id);
    const unsafePath = await fetch(`${origin}/media/voice-generations/${firstVoice.id}/file`);
    assert.equal(unsafePath.status, 500);
    assert.doesNotMatch(await unsafePath.text(), /outside\.wav/);
    db.prepare('UPDATE media_scene_voice_generations SET relative_path = ? WHERE id = ?').run(firstRow.relative_path, firstVoice.id);

    engineState.mode = 'error';
    const failed = await startVoice(origin, project.id, scene.id);
    assert.equal(failed.response.status, 202);
    const failedVoice = await waitForGeneration(failed.body.generation.id);
    assert.equal(failedVoice.status, 'failed');
    let afterFailure = await json(origin, `/media/projects/${project.id}`);
    assert.equal(afterFailure.body.scenes[0].voiceAudio.id, firstVoice.id);
    assert.equal(afterFailure.body.scenes[0].voiceAudio.active, true);
    engineState.mode = 'invalid';
    const invalidAudio = await startVoice(origin, project.id, scene.id);
    assert.equal((await waitForGeneration(invalidAudio.body.generation.id)).status, 'failed');
    afterFailure = await json(origin, `/media/projects/${project.id}`);
    assert.equal(afterFailure.body.scenes[0].voiceAudio.id, firstVoice.id);
    engineState.mode = 'timeout';
    const timedOut = await startVoice(origin, project.id, scene.id);
    assert.equal((await waitForGeneration(timedOut.body.generation.id)).error, 'La generación de voz excedió el límite de tiempo.');

    engineState.mode = 'wait';
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    engineState.start = signalStarted;
    const cancellable = await startVoice(origin, project.id, scene.id);
    assert.equal(cancellable.response.status, 202);
    await started;
    const duplicate = await startVoice(origin, project.id, scene.id);
    assert.equal(duplicate.response.status, 409);
    const cancelled = await json(origin, `/media/voice-generations/${cancellable.body.generation.id}/cancel`, { method: 'POST', body: '{}' });
    assert.equal(cancelled.response.status, 202);
    assert.equal((await waitForGeneration(cancellable.body.generation.id)).status, 'cancelled');
    engineState.mode = 'normal';
    engineState.start = null;

    const edit = await json(origin, `/media/scenes/${scene.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ voiceText: 'El texto de esta escena cambió y la voz anterior quedó desactualizada.' }),
    });
    assert.equal(edit.response.status, 200);
    assert.equal(edit.body.project.scenes[0].voiceAudio.stale, true);
    const staleRender = await json(origin, `/media/projects/${project.id}/render`, { method: 'POST', body: '{}' });
    assert.equal(staleRender.response.status, 409);
    engineState.durationSeconds = 6.2;
    const regenerated = await startVoice(origin, project.id, scene.id);
    const currentVoice = await waitForGeneration(regenerated.body.generation.id);
    assert.equal(currentVoice.status, 'completed');
    assert.notEqual(currentVoice.id, firstVoice.id);
    assert.equal(currentVoice.active, true);
    const syncedProject = await json(origin, `/media/projects/${project.id}`);
    assert.equal(syncedProject.body.scenes[0].plannedDurationSeconds, 5);
    assert.equal(syncedProject.body.scenes[0].durationSeconds, 7);
    assert.equal(syncedProject.body.durationSeconds, 7);
    assert.equal(syncedProject.body.scenes[0].voiceTiming.autoAdjusted, true);
    assert.equal(syncedProject.body.scenes[0].voiceTiming.needsMoreTime, false);
    assert.equal(syncedProject.body.voiceTimingSummary.marginSeconds, 0.5);
    db.prepare('UPDATE media_scene_voice_generations SET duration_seconds = NULL WHERE id = ?').run(currentVoice.id);
    const unknownDuration = await json(origin, `/media/projects/${project.id}`);
    assert.equal(unknownDuration.body.scenes[0].voiceDurationUnavailable, true);
    assert.equal(unknownDuration.body.voiceTimingSummary.confirmedVoiceScenes, 0);
    const unmeasuredRender = await json(origin, `/media/projects/${project.id}/render`, { method: 'POST', body: '{}' });
    assert.equal(unmeasuredRender.response.status, 409);
    assert.match(unmeasuredRender.body.error, /FFprobe no confirmó la duración/);
    db.prepare('UPDATE media_scene_voice_generations SET duration_seconds = ? WHERE id = ?')
      .run(currentVoice.durationSeconds, currentVoice.id);

    const invalidFileId = await fetch(`${origin}/media/voice-generations/not-a-uuid/file`);
    assert.equal(invalidFileId.status, 400);
    if (ffmpeg.ffmpeg.available) {
      const render = await json(origin, `/media/projects/${project.id}/render`, { method: 'POST', body: '{}' });
      assert.equal(render.response.status, 202, render.body.error);
      const jobId = render.body.job.id;
      const deadline = Date.now() + 90_000;
      let job;
      while (Date.now() < deadline) {
        const current = await json(origin, `/media/jobs/${jobId}`);
        job = current.body;
        if (['completed', 'failed', 'cancelled'].includes(job.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      assert.equal(job.status, 'completed', job.error || job.stage);
      const exported = db.prepare('SELECT * FROM media_exports WHERE job_id = ?').get(jobId);
      assert.ok(exported);
      assert.equal(exported.audio_codec, 'aac');
      assert.equal(exported.duration_seconds, 7);
      const mediaPath = join(directory, 'media', exported.relative_path);
      const probe = await execFileAsync(ffprobePath(), [
        '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', mediaPath,
      ], { timeout: 20_000, windowsHide: true });
      const streams = JSON.parse(probe.stdout).streams;
      assert.ok(streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
      assert.ok(streams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264'));
      const subtitle = await readFile(join(directory, 'media', exported.subtitle_path), 'utf8');
      assert.match(subtitle, /00:00:07,000/);
    } else {
      t.diagnostic('FFmpeg not found; real MP4 compatibility subtest skipped.');
    }

    const unlink = await json(origin, `/media/voice-generations/${currentVoice.id}/unlink`, { method: 'POST', body: '{}' });
    assert.equal(unlink.response.status, 200);
    assert.equal(unlink.body.project.scenes[0].voiceAudio, null);
    assert.equal(unlink.body.project.scenes[0].durationSeconds, 5);
    assert.equal(unlink.body.project.durationSeconds, 5);
    const retainedFile = await fetch(`${origin}/media/voice-generations/${currentVoice.id}/file`);
    assert.equal(retainedFile.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM media_scene_voice_generations WHERE project_id = ?').get(project.id).count, 6);
  } finally {
    await app.locals.mediaService.shutdown();
    await noVoiceApp.locals.mediaService.shutdown();
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => noVoiceServer.close(resolve)),
    ]);
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
    if (originalDatabasePath === undefined) delete process.env.VYRALIX_DB_PATH;
    else process.env.VYRALIX_DB_PATH = originalDatabasePath;
  }
});
