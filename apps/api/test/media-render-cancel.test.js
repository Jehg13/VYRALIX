import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('Media API terminates an in-progress FFmpeg render and cleans temporary output', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vyralix-render-cancel-'));
  const originalDatabasePath = process.env.VYRALIX_DB_PATH;
  const originalRenderTimeout = process.env.MEDIA_RENDER_TIMEOUT_MS;
  process.env.VYRALIX_DB_PATH = join(directory, 'vyralix.sqlite');
  process.env.MEDIA_RENDER_TIMEOUT_MS = '120000';

  let app;
  let server;
  let closeDatabase;
  let jobId;
  let api;

  try {
    const { db, dbPath, closeDatabase: close } = await import('../src/db.js');
    closeDatabase = close;
    assert.equal(dbPath, process.env.VYRALIX_DB_PATH, 'Render cancellation test must use its isolated database.');

    const { detectFfmpeg } = await import('../src/media/ffmpeg.js');
    const tools = await detectFfmpeg();
    if (!tools.ffmpeg.available || !tools.ffprobe.available) {
      t.skip('Real FFmpeg and FFprobe are required for active-process cancellation.');
      return;
    }

    const { createApp } = await import('../src/app.js');
    app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    api = async (path, options = {}) => {
      const response = await fetch(`${base}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers },
      });
      return { response, body: await response.json().catch(() => ({})) };
    };

    const post = await api('/posts', {
      method: 'POST',
      body: JSON.stringify({ title: 'Cancelación de render', category: 'Prueba', body: 'Escena aislada para verificar la cancelación de FFmpeg.' }),
    });
    assert.equal(post.response.status, 201, post.body.error);
    const created = await api('/media/projects', {
      method: 'POST',
      body: JSON.stringify({ postId: post.body.id, durationSeconds: 180 }),
    });
    assert.equal(created.response.status, 201, created.body.error);
    const projectId = created.body.project.id;
    const configured = await api(`/media/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ width: 1080, height: 1920, fps: 60, crf: 35, burnSubtitles: false }),
    });
    assert.equal(configured.response.status, 200, configured.body.error);

    const started = await api(`/media/projects/${projectId}/render`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(started.response.status, 202, started.body.error);
    jobId = started.body.job.id;

    const processingDeadline = Date.now() + 30_000;
    let processingJob;
    while (Date.now() < processingDeadline) {
      const current = await api(`/media/jobs/${jobId}`);
      assert.equal(current.response.status, 200, current.body.error);
      assert.ok(['preparing', 'processing'].includes(current.body.status),
        `Render terminó antes de la cancelación: ${current.body.status} ${current.body.error || ''}`);
      if (current.body.status === 'processing') {
        processingJob = current.body;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(processingJob, 'FFmpeg nunca llegó al estado de procesamiento.');
    assert.ok(processingJob.startedAt, 'El render no registró su inicio.');

    const cancellation = await api(`/media/jobs/${jobId}/cancel`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(cancellation.response.status, 202, cancellation.body.error);

    const cancelDeadline = Date.now() + 30_000;
    let finished;
    while (Date.now() < cancelDeadline) {
      const current = await api(`/media/jobs/${jobId}`);
      finished = current.body;
      if (['cancelled', 'completed', 'failed'].includes(finished.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(finished?.status, 'cancelled');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM media_exports WHERE job_id = ?').get(jobId).count, 0);
    assert.equal(db.prepare('SELECT status FROM media_projects WHERE id = ?').get(projectId).status, 'draft');
    const temporaryFiles = await readdir(join(directory, 'media', 'tmp'));
    assert.ok(!temporaryFiles.some((name) => name.startsWith(jobId)), 'Render cancelado dejó archivos temporales.');
  } finally {
    if (jobId && api) {
      const current = await api(`/media/jobs/${jobId}`).catch(() => null);
      if (current && ['queued', 'preparing', 'processing', 'validating'].includes(current.body.status)) {
        await api(`/media/jobs/${jobId}/cancel`, { method: 'POST', body: '{}' }).catch(() => {});
      }
    }
    if (app) await app.locals.mediaService.shutdown();
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    closeDatabase?.();
    await rm(directory, { recursive: true, force: true });
    if (originalDatabasePath === undefined) delete process.env.VYRALIX_DB_PATH;
    else process.env.VYRALIX_DB_PATH = originalDatabasePath;
    if (originalRenderTimeout === undefined) delete process.env.MEDIA_RENDER_TIMEOUT_MS;
    else process.env.MEDIA_RENDER_TIMEOUT_MS = originalRenderTimeout;
  }
});
