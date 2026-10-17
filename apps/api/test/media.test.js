import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { allocateSubtitleSegments, buildSrt, buildSubtitleAss, createScenePlan, scenePlanSchema } from '../src/media/scene-planner.js';
import { layoutSubtitleText } from '../src/media/subtitle-layout.js';
import { execFile } from 'node:child_process';
import { detectFfmpeg, ffmpegPath, ffprobePath } from '../src/media/ffmpeg.js';

const execFileAsync = promisify(execFile);
const multimediaAvailability = await detectFfmpeg();

test('FFmpeg diagnostics distinguish missing PATH tools, invalid configured paths, and launch failures', async () => {
  const missingExecutable = async () => {
    throw Object.assign(new Error('not found'), { code: 'ENOENT' });
  };
  const pathMissing = await detectFfmpeg({ env: {}, readCapabilityImpl: missingExecutable });
  assert.equal(pathMissing.ffmpeg.status, 'not_found');
  assert.equal(pathMissing.ffprobe.status, 'not_found');
  assert.match(pathMissing.ffmpeg.error, /PATH/u);

  const invalidConfiguredPath = await detectFfmpeg({
    env: { FFMPEG_PATH: 'C:\\tools\\missing-ffmpeg.exe', FFPROBE_PATH: 'C:\\tools\\missing-ffprobe.exe' },
    readCapabilityImpl: missingExecutable,
  });
  assert.equal(invalidConfiguredPath.ffmpeg.status, 'configured_path_not_found');
  assert.equal(invalidConfiguredPath.ffprobe.status, 'configured_path_not_found');
  assert.match(invalidConfiguredPath.ffmpeg.error, /FFMPEG_PATH/u);
  assert.match(invalidConfiguredPath.ffprobe.error, /FFPROBE_PATH/u);

  const launchFailure = await detectFfmpeg({
    env: {},
    readCapabilityImpl: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  });
  assert.equal(launchFailure.ffmpeg.status, 'execution_failed');
  assert.equal(launchFailure.ffprobe.status, 'execution_failed');

  const timedOut = await detectFfmpeg({
    env: {},
    readCapabilityImpl: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); },
  });
  assert.equal(timedOut.ffmpeg.status, 'timed_out');
  assert.equal(timedOut.ffprobe.status, 'timed_out');

  const capabilityCheckFailed = await detectFfmpeg({
    env: {},
    readCapabilityImpl: async (_binary, args) => {
      if (args[0] === '-version') return 'ffmpeg version test';
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    },
  });
  assert.equal(capabilityCheckFailed.ffmpeg.available, true);
  assert.equal(capabilityCheckFailed.ffmpeg.status, 'capability_check_failed');
});

test('scene plans validate duration totals and subtitles use estimated scene timings', () => {
  const plan = createScenePlan({
    title: 'Guion de prueba',
    category: 'Curiosidades',
    script: `${'Una frase larga sin pausas para que se divida correctamente. '.repeat(12)}`,
    durationSeconds: 45,
  });
  assert.equal(plan.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), 45);
  assert.ok(plan.scenes.length > 1);
  assert.ok(plan.scenes.every((scene) => scene.subtitleText.length <= 1000));
  assert.equal(scenePlanSchema.safeParse({ ...plan, durationSeconds: 30 }).success, false);

  const scenes = [
    { subtitleText: 'Primera línea', onScreenText: 'Texto arriba', durationSeconds: 4 },
    { subtitleText: '', durationSeconds: 2 },
    { subtitleText: 'Última línea', durationSeconds: 3 },
  ];
  assert.deepEqual(allocateSubtitleSegments(scenes).map((segment) => [segment.startSeconds, segment.endSeconds]), [[0, 4], [6, 9]]);
  assert.match(buildSrt(scenes), /00:00:06,000 --> 00:00:09,000/);
  assert.doesNotMatch(buildSrt(scenes), /Texto arriba/u);
  assert.match(buildSrt(scenes), /Primera línea/u);
});

test('subtitle layout wraps long text within safe geometry at supported vertical resolutions', () => {
  const longText = 'Una narración extensa sobre una jugada histórica, con palabras de distinta anchura y signos de puntuación.';
  for (const [width, height] of [[720, 1280], [1080, 1920]]) {
    const title = layoutSubtitleText('Copa Mundial de la FIFA 2022', { width, height, role: 'title' });
    const layout = layoutSubtitleText(longText, { width, height });
    assert.equal(title.lines.length, 1);
    assert.ok(title.bottom <= height * 0.26);
    assert.ok(title.left + title.maxLineWidth <= width - title.right);
    assert.ok(title.fontSizePixels >= title.minFontSizePixels);
    assert.ok(title.fontSizePixels <= title.maxFontSizePixels);
    assert.ok(layout.lines.length > 1);
    assert.ok(layout.lines.length <= layout.maxLines);
    assert.ok(layout.blockHeight <= layout.maxBlockHeight);
    assert.ok(layout.lines.every((line) => line.length > 0));
    assert.ok(layout.left >= width * 0.07);
    assert.ok(layout.right >= width * 0.18);
    assert.ok(layout.top >= height * 0.55);
    assert.ok(layout.bottom <= height * 0.7);
    assert.ok(title.bottom < layout.top);
    assert.ok(layout.fontSizePixels >= layout.minFontSizePixels);
    assert.ok(layout.fontSizePixels <= layout.maxFontSizePixels);
    assert.ok(layout.lines.every((line) => Array.from(line).length > 0));
    assert.ok(layout.lineWidths.every((lineWidth) => lineWidth <= layout.maxLineWidth));
  }
  assert.ok(layoutSubtitleText('M'.repeat(50), { width: 720, height: 1280 }).lines.length > 1);
  const shortCaption = layoutSubtitleText('Una jugada histórica con balón y emoción', { width: 1080, height: 1920 });
  assert.equal(shortCaption.fontSizePixels, shortCaption.maxFontSizePixels);
  const shortCaption720 = layoutSubtitleText('Una jugada histórica con balón y emoción', { width: 720, height: 1280 });
  assert.ok(Math.abs(shortCaption.fontSizePixels / 1080 - shortCaption720.fontSizePixels / 720) < 0.002);
  const resizedCaption = layoutSubtitleText(`${longText} ${longText.slice(0, 28)}`, { width: 1080, height: 1920 });
  assert.ok(resizedCaption.fontSizePixels < resizedCaption.maxFontSizePixels);

  const scenes = [{
    onScreenText: 'Título destacado',
    subtitleText: 'Nacido en Rosario, Lionel Messi construyó una trayectoria destacada en el fútbol profesional, consolidándose con el FC Barcelona.',
    durationSeconds: 4,
  }];
  const screenplay = buildSrt(scenes, { width: 720, height: 1280 });
  assert.doesNotMatch(screenplay, /Título destacado/u);
  assert.match(screenplay, /Nacido en Rosario/u);
  assert.ok(screenplay.split('\n').filter(Boolean).length > 4);
  const ass = buildSubtitleAss(scenes, { width: 720, height: 1280 });
  assert.match(ass, /PlayResX: 720\nPlayResY: 1280/u);
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:04\.00,Title/u);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:04\.00,Caption/u);
  assert.match(ass, /\\pos\(360,128\)\\fs\d+\\q2/u);
  assert.match(ass, /\\pos\(321,717\)\\fs\d+\\q2/u);
  assert.match(ass, /FC Barcelona/u);
});

test('subtitle layout explicitly rejects blocks that exceed safe regions or invalid frame geometry', () => {
  assert.throws(
    () => layoutSubtitleText('Palabra '.repeat(160), { width: 1080, height: 1920 }),
    { code: 'subtitle_layout_invalid' },
  );
  assert.throws(
    () => layoutSubtitleText('Texto de prueba', { width: 1080, height: 1280 }),
    { code: 'subtitle_layout_invalid' },
  );
  assert.throws(
    () => layoutSubtitleText('M'.repeat(1000), { width: 720, height: 1280 }),
    { code: 'subtitle_layout_invalid' },
  );
  assert.throws(
    () => layoutSubtitleText('Este título es demasiado largo para la banda superior segura y no se debe dibujar encima de la narración o del contenido visual', { width: 720, height: 1280, role: 'title' }),
    { code: 'subtitle_layout_invalid' },
  );
});

test('FFmpeg genera un MP4 de integración y FFprobe confirma su stream', {
  skip: !multimediaAvailability.ffmpeg.available || !multimediaAvailability.ffprobe.available,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vyralix-ffmpeg-test-'));
  const outputPath = join(directory, 'probe.mp4');
  try {
    await execFileAsync(ffmpegPath(), [
      '-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=0x171324:s=360x640:r=24:d=1',
      '-an', '-c:v', multimediaAvailability.ffmpeg.h264 ? 'libx264' : 'mpeg4',
      '-pix_fmt', 'yuv420p', outputPath,
    ], { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const { stdout } = await execFileAsync(ffprobePath(), [
      '-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type,width,height',
      '-of', 'json', outputPath,
    ], { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const metadata = JSON.parse(stdout);
    const video = metadata.streams.find((stream) => stream.codec_type === 'video');
    assert.equal(video.width, 360);
    assert.equal(video.height, 640);
    assert.ok(Math.abs(Number(metadata.format.duration) - 1) < 0.2);
    assert.ok(metadata.format.format_name.includes('mp4'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Media API imports local assets safely and persists projects, scenes and real render job states', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vyralix-media-test-'));
  const originalDatabasePath = process.env.VYRALIX_DB_PATH;
  const originalFfmpeg = process.env.FFMPEG_PATH;
  const originalFfprobe = process.env.FFPROBE_PATH;
  process.env.VYRALIX_DB_PATH = join(directory, 'vyralix.sqlite');
  process.env.FFMPEG_PATH = join(directory, 'missing-ffmpeg.exe');
  process.env.FFPROBE_PATH = join(directory, 'missing-ffprobe.exe');
  const { createApp } = await import('../src/app.js');
  const { closeDatabase, db } = await import('../src/db.js');
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const json = (path, options = {}) => fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pN8AAAAASUVORK5CYII=', 'base64');

  try {
    const diagnostic = await (await json('/media/diagnostics')).json();
    assert.equal(diagnostic.ffmpeg.ffmpeg.available, false);
    assert.equal(diagnostic.ffmpeg.ffprobe.available, false);
    assert.equal(diagnostic.voiceProviders[0].id, 'manual_import');

    const postResponse = await json('/posts', {
      method: 'POST',
      body: JSON.stringify({ title: 'Guion audiovisual', category: 'Curiosidades', body: 'Primera escena. Segunda escena. Cierre final.' }),
    });
    assert.equal(postResponse.status, 201);
    const post = await postResponse.json();
    const created = await json('/media/projects', {
      method: 'POST',
      body: JSON.stringify({ postId: post.id, durationSeconds: 30 }),
    });
    assert.equal(created.status, 201);
    const { project } = await created.json();
    assert.equal(project.width, 720);
    assert.equal(project.height, 1280);
    assert.equal(project.status, 'draft');
    assert.equal(project.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), 30);
    assert.equal((await json('/media/projects', {
      method: 'POST',
      body: JSON.stringify({ postId: post.id, durationSeconds: 30 }),
    })).status, 200);

    const invalidDuration = await json(`/media/scenes/${project.scenes[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({ durationSeconds: 0 }),
    });
    assert.equal(invalidDuration.status, 400);
    const updatedScene = await json(`/media/scenes/${project.scenes[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({ subtitleText: 'Texto ajustado', durationSeconds: project.scenes[0].durationSeconds + 1 }),
    });
    assert.equal(updatedScene.status, 200);
    const rebalancedProject = (await updatedScene.json()).project;
    assert.equal(rebalancedProject.durationSeconds, 31);
    assert.equal(rebalancedProject.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), 31);
    assert.equal((await json(`/posts/${post.id}`, { method: 'DELETE' })).status, 409);
    assert.equal((await json(`/media/projects/${project.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ width: 1080, height: 1280 }),
    })).status, 400);
    const targetDuration = await json(`/media/projects/${project.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ durationSeconds: 45 }),
    });
    assert.equal(targetDuration.status, 200);
    assert.equal((await targetDuration.json()).project.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), 45);

    const pathTraversal = await fetch(`${base}/media/assets`, {
      method: 'PUT',
      headers: { 'X-Media-Filename': encodeURIComponent('..\\outside.png'), 'Content-Type': 'application/octet-stream' },
      body: png,
    });
    assert.equal(pathTraversal.status, 400);
    const unsupported = await fetch(`${base}/media/assets`, {
      method: 'PUT',
      headers: { 'X-Media-Filename': 'payload.exe', 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('not an image'),
    });
    assert.equal(unsupported.status, 415);
    const mismatch = await fetch(`${base}/media/assets`, {
      method: 'PUT',
      headers: { 'X-Media-Filename': 'false.png', 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('not a png'),
    });
    assert.equal(mismatch.status, 415);

    const upload = () => fetch(`${base}/media/assets`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Media-Filename': 'tiny.png',
        'X-Media-Provenance': encodeURIComponent('Archivo propio'),
        'X-Media-License': encodeURIComponent('Uso propio'),
      },
      body: png,
    });
    const uploaded = await upload();
    assert.equal(uploaded.status, 201);
    const asset = (await uploaded.json()).asset;
    assert.equal(asset.kind, 'image');
    assert.equal(asset.provenance, 'Archivo propio');
    assert.equal(asset.missing, false);
    const duplicate = await upload();
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).asset.id, asset.id);
    const preview = await json(`/media/assets/${asset.id}/content`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(preview.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
    assert.equal((await json(`/media/assets/${asset.id}`, { method: 'DELETE' })).status, 400);

    const assigned = await json(`/media/scenes/${project.scenes[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({ assetId: asset.id, visualType: 'image' }),
    });
    assert.equal(assigned.status, 200, await assigned.clone().text());
    assert.equal((await json(`/media/assets/${asset.id}?confirm=true`, { method: 'DELETE' })).status, 409);
    const replaced = await json(`/media/scenes/${project.scenes[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({ assetId: null }),
    });
    assert.equal(replaced.status, 200);
    assert.equal((await json(`/media/assets/${asset.id}?confirm=true`, { method: 'DELETE' })).status, 204);

    const render = await json(`/media/projects/${project.id}/render`, { method: 'POST', body: '{}' });
    assert.equal(render.status, 202);
    const jobId = (await render.json()).job.id;
    const duplicateJob = await json(`/media/projects/${project.id}/render`, { method: 'POST', body: '{}' });
    assert.equal([200, 202].includes(duplicateJob.status), true);

    let job;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      job = await (await json(`/media/jobs/${jobId}`)).json();
      if (job.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(job.status, 'failed');
    assert.match(job.error, /FFmpeg/i);
    assert.notEqual(job.progress, 100);
    const retried = await json(`/media/jobs/${jobId}/retry`, { method: 'POST', body: '{}' });
    assert.equal(retried.status, 202);
    const retryJobId = (await retried.json()).job.id;
    let retryJob;
    const retryDeadline = Date.now() + 5000;
    while (Date.now() < retryDeadline) {
      retryJob = await (await json(`/media/jobs/${retryJobId}`)).json();
      if (retryJob.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(retryJob.status, 'failed');
    assert.equal(retryJob.attempt, 2);

    const queuedId = randomUUID();
    const time = new Date().toISOString();
    db.prepare(`INSERT INTO media_render_jobs (id, project_id, status, stage, config_json, created_at, updated_at)
      VALUES (?, ?, 'processing', 'Interrumpido', '{}', ?, ?)`).run(queuedId, project.id, time, time);
    assert.equal(app.locals.mediaService.recoverInterruptedJobs(), 1);
    assert.equal((await (await json(`/media/jobs/${queuedId}`)).json()).status, 'queued');
    const cancelled = await json(`/media/jobs/${queuedId}/cancel`, { method: 'POST', body: '{}' });
    assert.equal((await cancelled.json()).job.status, 'cancelled');
    assert.equal((await json('/media/exports')).status, 200);
  } finally {
    app.locals.mediaService.shutdown();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
    if (originalDatabasePath === undefined) delete process.env.VYRALIX_DB_PATH;
    else process.env.VYRALIX_DB_PATH = originalDatabasePath;
    if (originalFfmpeg === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = originalFfmpeg;
    if (originalFfprobe === undefined) delete process.env.FFPROBE_PATH;
    else process.env.FFPROBE_PATH = originalFfprobe;
  }
});
