import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { buildSrt, buildSubtitleAss, createScenePlan, projectFromRow, sceneSchema } from './scene-planner.js';
import { detectFfmpeg, ffmpegPath, ffprobePath } from './ffmpeg.js';
import {
  buildScenePlanningPrompt,
  buildSceneRegenerationPrompt,
  reviewedPlanSchema,
  scenePlanningSettingsSchema,
  validateAndNormalizeScenePlan,
  validateRegeneratedScene,
  validateReviewedSpeech,
  validateSourceScript,
} from './ai-scene-planner.js';
import { ProviderError, safeProviderError } from '../ai/provider-error.js';
import { createWindowsSpeechEngine } from './voice-engine.js';
import { allocateSceneDurations, getRequiredVoiceSceneDuration, getSceneTiming } from './scene-timing.js';
import { isValidPng } from './image-validation.js';

const projectIdSchema = z.string().uuid();
const visualReviewSchema = z.object({
  status: z.enum(['approved', 'needs_changes']),
  note: z.string().trim().max(1000).optional(),
}).strict();
const execFileAsync = promisify(execFile);
const assetIdSchema = z.string().uuid();
const projectCreateSchema = z.object({
  postId: projectIdSchema,
  durationSeconds: z.coerce.number().int().min(5).max(180).default(30),
});
const researchPlanSchema = z.object({
  centralIdea: z.string().min(1),
  durationSeconds: z.number().int().min(15).max(180),
  scenes: z.array(z.object({
    order: z.number().int().min(1).max(12),
    durationSeconds: z.number().int().min(1).max(180),
    voiceover: z.string().min(1).max(900),
    visualProposal: z.string().min(1).max(500),
  })).min(1).max(12),
}).superRefine((proposal, context) => {
  if (proposal.scenes.some((scene, index) => scene.order !== index + 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes'], message: 'El orden de escenas no es consecutivo.' });
  }
  if (proposal.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0) !== proposal.durationSeconds) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes'], message: 'La duración de las escenas no coincide con la propuesta.' });
  }
});
const projectUpdateSchema = z.object({
  durationSeconds: z.number().int().min(5).max(180).optional(),
  width: z.union([z.literal(720), z.literal(1080)]).optional(),
  height: z.union([z.literal(1280), z.literal(1920)]).optional(),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).optional(),
  crf: z.number().int().min(18).max(35).optional(),
  burnSubtitles: z.boolean().optional(),
  voiceAssetId: assetIdSchema.nullable().optional(),
  musicAssetId: assetIdSchema.nullable().optional(),
}).strict().superRefine((values, context) => {
  if (values.width !== undefined && values.height !== undefined && values.width * 16 !== values.height * 9) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['height'], message: 'La resolución debe mantener la relación 9:16.' });
  }
});
const sceneUpdateSchema = sceneSchema.partial().extend({
  assetId: assetIdSchema.nullable().optional(),
  title: z.string().max(120).optional(),
  narrativeGoal: z.string().max(300).optional(),
  dialogue: z.string().max(3000).optional(),
  shotType: z.string().max(120).optional(),
  cameraMovement: z.string().max(240).optional(),
  actionDescription: z.string().max(500).optional(),
  environment: z.string().max(300).optional(),
  lighting: z.string().max(240).optional(),
  palette: z.string().max(120).optional(),
  continuityBefore: z.string().max(300).optional(),
  continuityAfter: z.string().max(300).optional(),
  audioNotes: z.string().max(300).optional(),
}).strict();
const planRequestSchema = z.object({ settings: scenePlanningSettingsSchema }).strict();
const applyPlanRequestSchema = z.object({
  settings: scenePlanningSettingsSchema,
  plan: reviewedPlanSchema,
  provider: z.enum(['gemini', 'groq', 'ollama']),
  model: z.string().max(120).nullable(),
  preserveAssets: z.boolean().default(false),
}).strict();
const regenerateSceneRequestSchema = z.object({
  settings: scenePlanningSettingsSchema,
  plan: reviewedPlanSchema,
}).strict();
const sceneVoiceRequestSchema = z.object({
  voiceId: z.string().trim().min(1).max(200),
  rate: z.number().int().min(-5).max(5).default(0),
  volume: z.number().int().min(20).max(100).default(100),
}).strict();
const assetQuerySchema = z.object({
  kind: z.enum(['image', 'video', 'audio']).optional(),
  search: z.string().max(120).optional(),
});
const provenanceSchema = z.object({
  provenance: z.string().trim().max(300).default('Importado localmente'),
  license: z.string().trim().max(300).default('Sin verificar'),
});
const supportedExtensions = new Map([
  ['.png', { kind: 'image', mime: 'image/png' }],
  ['.jpg', { kind: 'image', mime: 'image/jpeg' }],
  ['.jpeg', { kind: 'image', mime: 'image/jpeg' }],
  ['.webp', { kind: 'image', mime: 'image/webp' }],
  ['.mp4', { kind: 'video', mime: 'video/mp4' }],
  ['.mov', { kind: 'video', mime: 'video/quicktime' }],
  ['.webm', { kind: 'video', mime: 'video/webm' }],
  ['.mp3', { kind: 'audio', mime: 'audio/mpeg' }],
  ['.wav', { kind: 'audio', mime: 'audio/wav' }],
  ['.m4a', { kind: 'audio', mime: 'audio/mp4' }],
  ['.ogg', { kind: 'audio', mime: 'audio/ogg' }],
]);

function timestamp() {
  return new Date().toISOString();
}

function jsonAsset(row, missing = !existsSync(row.absolute_path || '')) {
  return {
    id: row.id,
    kind: row.kind,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    durationSeconds: row.duration_seconds,
    width: row.width,
    height: row.height,
    provenance: row.provenance,
    license: row.license,
    missing,
    createdAt: row.created_at,
  };
}

function publicJob(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    error: row.error_message,
    attempt: row.attempt,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeRelativePath(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\0') ||
    path.split(/[\\/]/).some((part) => part === '..')) {
    throw new Error('La ruta multimedia está fuera de la carpeta administrada.');
  }
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('La ruta multimedia está fuera de la carpeta administrada.');
  }
  return absolute;
}

function safeError(error) {
  const message = String(error?.message || 'Error multimedia desconocido')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '[ruta local]')
    .replace(/(?:\/[^ \n"']+)+/g, '[ruta local]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 600);
  return message || 'Error multimedia desconocido.';
}

function allowedMagic(kind, extension, header) {
  if (extension === '.png') return header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === '.jpg' || extension === '.jpeg') return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (extension === '.webp') return header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
  if (['.mp4', '.mov', '.m4a'].includes(extension)) return header.toString('ascii', 4, 8) === 'ftyp';
  if (extension === '.webm') return header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (extension === '.wav') return header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE';
  if (extension === '.ogg') return header.toString('ascii', 0, 4) === 'OggS';
  if (extension === '.mp3') {
    return header.toString('ascii', 0, 3) === 'ID3' || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0);
  }
  return false;
}

function decodeFilename(value) {
  let name;
  try {
    name = decodeURIComponent(value || '');
  } catch {
    throw Object.assign(new Error('El nombre del archivo no es válido.'), { status: 400 });
  }
  if (!name || name.length > 255 || basename(name) !== name || /[\\/\0-\x1f\x7f]/.test(name) || name === '.' || name === '..') {
    throw Object.assign(new Error('El nombre del archivo no es válido.'), { status: 400 });
  }
  return name;
}

function decodeHeader(value, fallback) {
  if (!value) return fallback;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function ffmpegProgressTime(value) {
  if (!value) return null;
  const [hours, minutes, seconds] = value.split(':').map(Number);
  if ([hours, minutes, seconds].some((item) => !Number.isFinite(item))) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function escapedFilterPath(path) {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function scaleDurations(scenes, target) {
  if (!scenes.length || target < scenes.length) throw new Error('La duración elegida es demasiado corta para el número de escenas.');
  const weights = scenes.map((scene) => Math.max(1, scene.duration_seconds));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const scaled = weights.map((value) => Math.max(1, Math.floor((target * value) / total)));
  let difference = target - scaled.reduce((sum, value) => sum + value, 0);
  const order = weights.map((weight, index) => ({ index, remainder: (target * weight) % total }))
    .sort((a, b) => b.remainder - a.remainder);
  let cursor = 0;
  while (difference > 0) {
    scaled[order[cursor % order.length].index] += 1;
    cursor += 1;
    difference -= 1;
  }
  while (difference < 0) {
    const candidate = order.slice().reverse().find(({ index }) => scaled[index] > 1);
    if (!candidate) throw new Error('No se pudo ajustar la duración de las escenas.');
    scaled[candidate.index] -= 1;
    difference += 1;
  }
  return scaled;
}

export function createMediaService({ database, dataDirectory, aiRouter, voiceEngine = createWindowsSpeechEngine() }) {
  const mediaRoot = resolve(dataDirectory, 'media');
  const assetsDirectory = join(mediaRoot, 'assets');
  const exportsDirectory = join(mediaRoot, 'exports');
  const voicesDirectory = join(mediaRoot, 'voices');
  const temporaryDirectory = join(mediaRoot, 'tmp');
  const maxUploadBytes = Math.max(1024 * 1024, Math.min(Number(process.env.MEDIA_MAX_UPLOAD_BYTES) || 250 * 1024 * 1024, 1024 * 1024 * 1024));
  const timeoutMs = Math.max(60_000, Math.min(Number(process.env.MEDIA_RENDER_TIMEOUT_MS) || 30 * 60_000, 4 * 60 * 60_000));
  const maxConcurrent = Math.max(1, Math.min(Number(process.env.MEDIA_MAX_CONCURRENT) || 1, 2));
  const voiceSceneMarginSeconds = process.env.MEDIA_VOICE_SCENE_MARGIN_SECONDS === undefined
    ? 0.5
    : z.coerce.number().finite().min(0).max(3).parse(process.env.MEDIA_VOICE_SCENE_MARGIN_SECONDS);
  const running = new Map();
  const activeTasks = new Map();
  const activeVoiceControllers = new Map();
  const activeVoiceTasks = new Map();
  const cancelling = new Set();
  let pumping = false;
  let voiceCatalogCache = null;
  let voiceCatalogExpiresAt = 0;
  mkdirSyncSafe();

  function mkdirSyncSafe() {
    for (const directory of [mediaRoot, assetsDirectory, exportsDirectory, voicesDirectory, temporaryDirectory]) {
      mkdirSync(directory, { recursive: true });
    }
  }

  function assetPath(asset) {
    return safeRelativePath(mediaRoot, asset.relative_path);
  }

  function getAsset(id) {
    return database.prepare('SELECT * FROM media_assets WHERE id = ?').get(id);
  }

  function getProject(id) {
    return database.prepare('SELECT * FROM media_projects WHERE id = ?').get(id);
  }

  function voiceGenerationJson(row, currentText = '') {
    if (!row) return null;
    const stale = row.status === 'completed' && row.source_sha256 !== createHash('sha256').update(currentText).digest('hex');
    return {
      id: row.id,
      projectId: row.project_id,
      sceneId: row.scene_id,
      provider: row.provider,
      voiceId: row.voice_id,
      language: row.language,
      rate: row.rate,
      volume: row.volume,
      status: row.status,
      active: Boolean(row.is_active),
      stale,
      durationSeconds: row.duration_seconds,
      format: row.format,
      sampleRate: row.sample_rate,
      channels: row.channels,
      sizeBytes: row.size_bytes,
      error: row.error_message,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      fileUrl: row.status === 'completed' ? `/media/voice-generations/${row.id}/file` : null,
    };
  }

  function getProjectJson(id) {
    const row = getProject(id);
    if (!row) return null;
    const project = projectFromRow(row, database);
    return {
      ...project,
      scenes: project.scenes.map((scene) => {
        const generations = database.prepare(`SELECT * FROM media_scene_voice_generations
          WHERE scene_id = ? ORDER BY created_at DESC LIMIT 20`).all(scene.id);
        const active = generations.find((generation) => generation.is_active === 1) || null;
        const voiceAudio = voiceGenerationJson(active, scene.voiceText);
        const voiceMatchesText = active?.status === 'completed' && !voiceAudio.stale;
        const voiceDurationUnavailable = voiceMatchesText &&
          (!Number.isFinite(active.duration_seconds) || active.duration_seconds <= 0);
        return {
          ...scene,
          voiceAudio,
          voiceGeneration: voiceGenerationJson(generations[0] || null, scene.voiceText),
          voiceTiming: getSceneTiming({
            plannedDurationSeconds: scene.plannedDurationSeconds,
            currentDurationSeconds: scene.durationSeconds,
            voiceDurationSeconds: voiceMatchesText ? active.duration_seconds : null,
            marginSeconds: voiceSceneMarginSeconds,
            durationSource: scene.durationSource,
          }),
          voiceDurationUnavailable,
        };
      }),
      voiceTimingSummary: (() => {
        const requiredTotal = project.scenes.reduce((sum, scene) => {
          const active = database.prepare(`SELECT duration_seconds, source_sha256 FROM media_scene_voice_generations
            WHERE scene_id = ? AND is_active = 1 AND status = 'completed'`).get(scene.id);
          const duration = active && active.source_sha256 === createHash('sha256').update(scene.voiceText).digest('hex')
            ? getRequiredVoiceSceneDuration(active.duration_seconds, voiceSceneMarginSeconds)
            : null;
          return sum + Math.max(scene.plannedDurationSeconds, duration || scene.plannedDurationSeconds);
        }, 0);
        return {
          marginSeconds: voiceSceneMarginSeconds,
          requiredDurationSeconds: requiredTotal,
          projectLimitSeconds: 180,
          exceedsProjectLimit: requiredTotal > 180,
          confirmedVoiceScenes: project.scenes.filter((scene) => {
            const active = database.prepare(`SELECT source_sha256, duration_seconds FROM media_scene_voice_generations
              WHERE scene_id = ? AND is_active = 1 AND status = 'completed'`).get(scene.id);
            return active?.source_sha256 === createHash('sha256').update(scene.voiceText).digest('hex') &&
              Number.isFinite(active.duration_seconds) && active.duration_seconds > 0;
          }).length,
        };
      })(),
    };
  }

  function recalculateVoiceTimings(projectId, updatedAt) {
    const rows = database.prepare(`SELECT s.id, s.duration_seconds, s.planned_duration_seconds, s.duration_source,
        s.voice_text, g.duration_seconds AS voice_duration_seconds, g.source_sha256
      FROM media_scenes s
      LEFT JOIN media_scene_voice_generations g
        ON g.scene_id = s.id AND g.is_active = 1 AND g.status = 'completed'
      WHERE s.project_id = ? ORDER BY s.scene_order`).all(projectId);
    const scenes = rows.map((row) => {
      const voiceDurationSeconds = row.source_sha256 === createHash('sha256').update(row.voice_text).digest('hex')
        ? row.voice_duration_seconds
        : null;
      return {
        ...row,
        plannedDurationSeconds: row.planned_duration_seconds,
        durationSource: row.duration_source,
        timing: getSceneTiming({
          plannedDurationSeconds: row.planned_duration_seconds,
          currentDurationSeconds: row.duration_seconds,
          voiceDurationSeconds,
          marginSeconds: voiceSceneMarginSeconds,
          durationSource: row.duration_source,
        }),
      };
    });
    const targets = allocateSceneDurations(scenes.map((scene) => ({
      plannedDurationSeconds: scene.plannedDurationSeconds,
      targetDurationSeconds: scene.timing.targetDurationSeconds,
    })), 180);
    const total = targets.reduce((sum, duration) => sum + duration, 0);
    const transaction = database.transaction(() => {
      const update = database.prepare(`UPDATE media_scenes SET duration_seconds = ?,
        planned_duration_seconds = ?, duration_source = ?, updated_at = ? WHERE id = ?`);
      scenes.forEach((scene, index) => update.run(
        targets[index],
        scene.plannedDurationSeconds,
        scene.durationSource,
        updatedAt,
        scene.id,
      ));
      database.prepare(`UPDATE media_projects SET duration_seconds = ?, status = 'draft', updated_at = ? WHERE id = ?`)
        .run(total, updatedAt, projectId);
    });
    transaction();
    return { durationSeconds: total, exceedsProjectLimit: scenes.some((scene, index) => targets[index] < scene.timing.targetDurationSeconds) };
  }

  async function availableVoiceProviders() {
    if (!voiceCatalogCache || Date.now() >= voiceCatalogExpiresAt) {
      try {
        const voices = await voiceEngine.listVoices();
        voiceCatalogCache = [{
          id: voiceEngine.id,
          available: voices.length > 0,
          description: 'Síntesis local de Windows SAPI; no envía texto por internet ni usa créditos.',
          voices,
          error: voices.length ? null : 'No hay voces instaladas en Windows.',
        }];
      } catch (error) {
        voiceCatalogCache = [{
          id: voiceEngine.id,
          available: false,
          description: 'Síntesis local de Windows SAPI.',
          voices: [],
          error: error.code === 'tts_unavailable'
            ? 'Windows SAPI no está disponible en este equipo.'
            : 'No se pudo consultar las voces locales instaladas.',
        }];
      }
      voiceCatalogExpiresAt = Date.now() + 30_000;
    }
    return [{
      id: 'manual_import',
      available: true,
      description: 'Usar una grabación de voz importada localmente.',
      voices: [],
      error: null,
    }, ...voiceCatalogCache];
  }

  async function diagnostic() {
    const ffmpeg = await detectFfmpeg();
    const assetCount = database.prepare('SELECT COUNT(*) AS count FROM media_assets').get().count;
    const projectCount = database.prepare('SELECT COUNT(*) AS count FROM media_projects').get().count;
    const activeJobs = database.prepare(`SELECT COUNT(*) AS count FROM media_render_jobs
      WHERE status IN ('queued', 'preparing', 'processing', 'validating')`).get().count;
    return {
      ffmpeg,
      voiceProviders: await availableVoiceProviders(),
      limits: {
        maxUploadBytes,
        maxConcurrent,
        maxDurationSeconds: 180,
        defaultWidth: 720,
        defaultHeight: 1280,
        voiceSceneMarginSeconds,
      },
      counts: { assets: assetCount, projects: projectCount, activeJobs },
      storage: { mediaDirectory: 'data/media', exportsDirectory: 'data/media/exports' },
    };
  }

  function getAssetMetadata(id) {
    const row = getAsset(id);
    if (!row) return null;
    const absolutePath = assetPath(row);
    return jsonAsset({ ...row, absolute_path: absolutePath });
  }

  async function importAsset(req, res) {
    const name = decodeFilename(req.get('x-media-filename'));
    const extension = extname(name).toLowerCase();
    const definition = supportedExtensions.get(extension);
    if (!definition) return res.status(415).json({ error: 'Formato no permitido. Importa PNG, JPEG, WebP, MP4, MOV, WebM, MP3, WAV, M4A u OGG.' });
    const declaredLength = Number(req.get('content-length') || 0);
    if (declaredLength > maxUploadBytes) return res.status(413).json({ error: `El archivo excede el límite de ${Math.round(maxUploadBytes / 1024 / 1024)} MiB.` });
    const metadata = provenanceSchema.safeParse({
      provenance: decodeHeader(req.get('x-media-provenance'), undefined),
      license: decodeHeader(req.get('x-media-license'), undefined),
    });
    if (!metadata.success) return res.status(400).json({ error: 'La procedencia o licencia excede el límite permitido.' });

    const id = randomUUID();
    const temporaryPath = join(temporaryDirectory, `${id}.upload`);
    const outputPath = join(assetsDirectory, `${id}${extension}`);
    const hash = createHash('sha256');
    let file;
    let size = 0;
    let firstBytes = Buffer.alloc(0);
    try {
      file = await open(temporaryPath, 'wx', 0o600);
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxUploadBytes) {
          req.resume();
          throw Object.assign(new Error(`El archivo excede el límite de ${Math.round(maxUploadBytes / 1024 / 1024)} MiB.`), { status: 413 });
        }
        if (firstBytes.length < 32) firstBytes = Buffer.concat([firstBytes, chunk.subarray(0, 32 - firstBytes.length)]);
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      await file.close();
      file = null;
      if (!size || !allowedMagic(definition.kind, extension, firstBytes)) {
        throw Object.assign(new Error('El contenido no coincide con el formato multimedia anunciado.'), { status: 415 });
      }
      const digest = hash.digest('hex');
      const duplicate = database.prepare('SELECT * FROM media_assets WHERE sha256 = ?').get(digest);
      if (duplicate) {
        await rm(temporaryPath, { force: true });
        return res.status(200).json({ asset: getAssetMetadata(duplicate.id), duplicate: true });
      }
      const relativePath = `assets/${id}${extension}`;
      await rename(temporaryPath, outputPath);
      const transaction = database.transaction(() => {
        database.prepare(`INSERT INTO media_assets
          (id, kind, original_name, relative_path, mime_type, size_bytes, sha256, provenance, license, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, definition.kind, name, relativePath, definition.mime, size, digest,
          metadata.data.provenance, metadata.data.license, timestamp(),
        );
      });
      try {
        transaction();
      } catch (error) {
        await rm(outputPath, { force: true });
        throw error;
      }
      const asset = getAssetMetadata(id);
      void enrichAssetMetadata(id);
      return res.status(201).json({ asset, duplicate: false });
    } catch (error) {
      if (file) await file.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
      if (!res.headersSent && !res.destroyed) {
        const status = error.status || (error.code === 'ENOSPC' ? 507 : 500);
        return res.status(status).json({ error: error.status ? error.message : 'No se pudo importar el archivo. Comprueba el espacio disponible y el registro local.' });
      }
    }
  }

  async function saveGeneratedImage(buffer, providerName, model) {
    if (!isValidPng(buffer)) {
      throw Object.assign(new Error('El contenido generado no es un PNG válido.'), { status: 415 });
    }
    if (buffer.length > maxUploadBytes) {
      throw Object.assign(new Error(`La imagen generada excede el límite de ${Math.round(maxUploadBytes / 1024 / 1024)} MiB configurado para la biblioteca.`), { status: 413 });
    }
    const id = randomUUID();
    const name = `gemini-${id}.png`;
    const temporaryPath = join(temporaryDirectory, `${id}.generated`);
    const outputPath = join(assetsDirectory, `${id}.png`);
    const digest = createHash('sha256').update(buffer).digest('hex');
    const duplicate = database.prepare('SELECT * FROM media_assets WHERE sha256 = ?').get(digest);
    if (duplicate) return { asset: getAssetMetadata(duplicate.id), duplicate: true };

    await writeFile(temporaryPath, buffer, { flag: 'wx', mode: 0o600 });
    try {
      await rename(temporaryPath, outputPath);
      const transaction = database.transaction(() => {
        database.prepare(`INSERT INTO media_assets
          (id, kind, original_name, relative_path, mime_type, size_bytes, sha256, provenance, license, created_at)
          VALUES (?, 'image', ?, ?, 'image/png', ?, ?, ?, ?, ?)`).run(
          id, name, `assets/${id}.png`, buffer.length, digest,
          `Generada mediante ${providerName}`, `Imagen generada con ${model}; términos de uso por verificar`, timestamp(),
        );
      });
      try {
        transaction();
      } catch (error) {
        await rm(outputPath, { force: true });
        throw error;
      }
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
    const asset = getAssetMetadata(id);
    void enrichAssetMetadata(id);
    return { asset, duplicate: false };
  }

  async function enrichAssetMetadata(id) {
    const asset = getAsset(id);
    if (!asset) return;
    const ffprobe = await detectFfmpeg();
    if (!ffprobe.ffprobe.available) return;
    try {
      const result = await runExecFile(ffprobePath(), [
        '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height',
        '-of', 'json', assetPath(asset),
      ], 10_000);
      const metadata = JSON.parse(result.stdout);
      const video = metadata.streams?.find((stream) => stream.codec_type === 'video');
      const audio = metadata.streams?.find((stream) => stream.codec_type === 'audio');
      const duration = Number(metadata.format?.duration);
      database.prepare(`UPDATE media_assets SET duration_seconds = ?, width = ?, height = ? WHERE id = ?`)
        .run(Number.isFinite(duration) ? duration : null, video?.width || null, video?.height || null, id);
      if (!video && !audio) throw new Error('No se detectaron streams multimedia.');
    } catch (error) {
      console.warn(JSON.stringify({ level: 'warn', event: 'media_metadata_probe_failed', assetId: id, code: error.code || 'probe_error' }));
    }
  }

  function startProject(input, res) {
    const parsed = projectCreateSchema.safeParse(input);
    if (!parsed.success) return res.status(400).json({ error: 'El contenido de origen o la duración no son válidos.' });
    const post = database.prepare('SELECT * FROM posts WHERE id = ?').get(parsed.data.postId);
    if (!post) return res.status(404).json({ error: 'No se encontró el borrador de origen.' });
    if (!['draft', 'pending_review', 'approved'].includes(post.status)) {
      return res.status(409).json({ error: 'Solo se puede iniciar un proyecto desde un borrador, contenido en revisión o aprobado.' });
    }
    const existing = getProjectJson(database.prepare('SELECT id FROM media_projects WHERE post_id = ?').get(post.id)?.id);
    if (existing) return res.status(200).json({ project: existing, existing: true });
    const projectId = randomUUID();
    const researchRow = database.prepare(`SELECT proposal_json FROM research_sessions
      WHERE media_post_id = ? AND proposal_status = 'sent_to_media'`).get(post.id);
    let plan;
    if (researchRow) {
      let proposal;
      try {
        proposal = JSON.parse(researchRow.proposal_json);
      } catch {
        return res.status(409).json({ error: 'La propuesta vinculada no se puede leer; no se modificó el proyecto.' });
      }
      const validated = researchPlanSchema.safeParse(proposal);
      if (!validated.success) return res.status(409).json({ error: 'La propuesta vinculada tiene escenas inválidas; no se modificó el proyecto.' });
      plan = {
        title: post.title,
        category: post.category,
        narrativeGoal: validated.data.centralIdea.slice(0, 500),
        durationSeconds: validated.data.durationSeconds,
        sourceScript: (post.body || post.title).slice(0, 5000),
        scenes: validated.data.scenes.map((scene, index) => ({
          order: index,
          durationSeconds: scene.durationSeconds,
          voiceText: scene.voiceover,
          subtitleText: scene.voiceover,
          visualDescription: scene.visualProposal,
          visualType: 'image',
          movement: '',
          transition: index === 0 ? 'cut' : 'fade',
          onScreenText: '',
          visualPrompt: scene.visualProposal,
        })),
      };
    } else {
      plan = createScenePlan({
        title: post.title,
        category: post.category,
        script: post.body || post.title,
        durationSeconds: parsed.data.durationSeconds,
      });
    }
    const timestampValue = timestamp();
    const transaction = database.transaction(() => {
      database.prepare(`INSERT INTO media_projects
        (id, post_id, title, category, source_script, duration_seconds, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        projectId, post.id, plan.title, plan.category, plan.sourceScript,
        plan.durationSeconds, timestampValue, timestampValue,
      );
      const addScene = database.prepare(`INSERT INTO media_scenes
        (id, project_id, scene_order, duration_seconds, planned_duration_seconds, duration_source, voice_text, subtitle_text, visual_description,
         visual_type, movement, transition, on_screen_text, visual_prompt, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'estimated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const addSceneDetails = database.prepare(`INSERT INTO media_scene_details
        (scene_id, title, narrative_goal, dialogue, shot_type, camera_movement, action_description,
         environment, lighting, palette, continuity_before, continuity_after, audio_notes, visual_pending)
        VALUES (?, ?, ?, '', '', '', '', '', '', '', '', '', '', ?)`);
      for (const scene of plan.scenes) {
        const sceneId = randomUUID();
        addScene.run(
        sceneId, projectId, scene.order, scene.durationSeconds, scene.durationSeconds, scene.voiceText, scene.subtitleText,
        scene.visualDescription, scene.visualType, scene.movement, scene.transition,
        scene.onScreenText, scene.visualPrompt, timestampValue, timestampValue,
        );
        if (researchRow) addSceneDetails.run(sceneId, `Escena ${scene.order + 1}`, plan.narrativeGoal, 1);
      }
    });
    transaction();
    return res.status(201).json({ project: getProjectJson(projectId), existing: false });
  }

  function patchProject(id, body, res) {
    const parsed = projectUpdateSchema.safeParse(body);
    if (!parsed.success) return res.status(400).json({ error: 'La configuración de exportación no es válida.' });
    const project = getProject(id);
    if (!project) return res.status(404).json({ error: 'No se encontró el proyecto.' });
    if (['rendering'].includes(project.status)) return res.status(409).json({ error: 'No se puede cambiar el proyecto durante el renderizado.' });
    const value = parsed.data;
    const width = value.width ?? project.width;
    const height = value.height ?? project.height;
    if (width * 16 !== height * 9) return res.status(400).json({ error: 'La resolución debe mantener la relación vertical 9:16.' });
    for (const field of ['voiceAssetId', 'musicAssetId']) {
      const assetId = value[field];
      if (assetId === undefined || assetId === null) continue;
      const asset = getAsset(assetId);
      if (!asset || asset.kind !== 'audio') return res.status(400).json({ error: 'La narración y la música deben ser recursos de audio importados.' });
    }
    const scenes = database.prepare('SELECT * FROM media_scenes WHERE project_id = ? ORDER BY scene_order').all(id);
    if (value.durationSeconds !== undefined) {
      const durations = scaleDurations(scenes.map((scene) => ({
        ...scene,
        duration_seconds: scene.planned_duration_seconds,
      })), value.durationSeconds);
      const updateDuration = database.prepare(`UPDATE media_scenes SET duration_seconds = ?,
        planned_duration_seconds = ?, duration_source = 'manual', updated_at = ? WHERE id = ?`);
      scenes.forEach((scene, index) => updateDuration.run(durations[index], durations[index], timestamp(), scene.id));
    }
    const fields = {
      duration_seconds: value.durationSeconds,
      width: value.width,
      height: value.height,
      fps: value.fps,
      crf: value.crf,
      burn_subtitles: value.burnSubtitles === undefined ? undefined : Number(value.burnSubtitles),
      voice_asset_id: value.voiceAssetId,
      music_asset_id: value.musicAssetId,
    };
    const updates = Object.entries(fields).filter(([, item]) => item !== undefined);
    if (updates.length) {
      database.prepare(`UPDATE media_projects SET ${updates.map(([field]) => `${field} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...updates.map(([, item]) => item), timestamp(), id);
    }
    if (value.durationSeconds !== undefined) recalculateVoiceTimings(id, timestamp());
    database.prepare(`UPDATE media_projects SET status = 'draft', updated_at = ? WHERE id = ? AND status IN ('failed', 'completed')`)
      .run(timestamp(), id);
    return res.json({ project: getProjectJson(id) });
  }

  function patchScene(sceneId, body, res) {
    const parsed = sceneUpdateSchema.safeParse(body);
    if (!parsed.success) return res.status(400).json({ error: 'Los campos de la escena no son válidos.' });
    const scene = database.prepare('SELECT * FROM media_scenes WHERE id = ?').get(sceneId);
    if (!scene) return res.status(404).json({ error: 'No se encontró la escena.' });
    const project = getProject(scene.project_id);
    if (project.status === 'rendering') return res.status(409).json({ error: 'No se puede cambiar una escena durante el renderizado.' });
    const value = parsed.data;
    if (value.assetId !== undefined && value.assetId !== null) {
      const asset = getAsset(value.assetId);
      if (!asset) return res.status(404).json({ error: 'No se encontró el recurso multimedia.' });
      if (!['image', 'video'].includes(asset.kind)) return res.status(400).json({ error: 'Una escena visual solo admite una imagen o un clip de video.' });
    }
    const fields = {
      scene_order: value.order,
      voice_text: value.voiceText,
      subtitle_text: value.subtitleText,
      visual_description: value.visualDescription,
      visual_type: value.visualType,
      movement: value.movement,
      transition: value.transition,
      on_screen_text: value.onScreenText,
      visual_prompt: value.visualPrompt,
      asset_id: value.assetId,
    };
    const detailFields = {
      title: value.title,
      narrative_goal: value.narrativeGoal,
      dialogue: value.dialogue,
      shot_type: value.shotType,
      camera_movement: value.cameraMovement,
      action_description: value.actionDescription,
      environment: value.environment,
      lighting: value.lighting,
      palette: value.palette,
      continuity_before: value.continuityBefore,
      continuity_after: value.continuityAfter,
      audio_notes: value.audioNotes,
    };
    const updates = Object.entries(fields).filter(([, item]) => item !== undefined);
    const detailUpdates = Object.entries(detailFields).filter(([, item]) => item !== undefined);
    const durationChanged = value.durationSeconds !== undefined && value.durationSeconds !== scene.duration_seconds;
    const plannedDuration = durationChanged ? value.durationSeconds : scene.planned_duration_seconds;
    if (durationChanged) {
      const plannedTotal = database.prepare(`SELECT SUM(planned_duration_seconds) AS total
        FROM media_scenes WHERE project_id = ?`).get(scene.project_id).total;
      const nextPlannedTotal = plannedTotal - scene.planned_duration_seconds + plannedDuration;
      if (nextPlannedTotal < 5 || nextPlannedTotal > 180) {
        return res.status(400).json({ error: 'La duración base total del proyecto debe mantenerse entre 5 y 180 segundos.' });
      }
    }
    const timestampValue = timestamp();
    const transaction = database.transaction(() => {
      if (updates.length) database.prepare(`UPDATE media_scenes SET ${updates.map(([field]) => `${field} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...updates.map(([, item]) => item), timestampValue, sceneId);
      if (durationChanged) {
        database.prepare(`UPDATE media_scenes SET planned_duration_seconds = ?, duration_source = 'manual'
          WHERE id = ?`).run(plannedDuration, sceneId);
      }
      if (detailUpdates.length || value.assetId !== undefined) {
        const existingDetails = database.prepare('SELECT * FROM media_scene_details WHERE scene_id = ?').get(sceneId);
        const details = {
          title: existingDetails?.title || '',
          narrative_goal: existingDetails?.narrative_goal || '',
          dialogue: existingDetails?.dialogue || '',
          shot_type: existingDetails?.shot_type || '',
          camera_movement: existingDetails?.camera_movement || '',
          action_description: existingDetails?.action_description || '',
          environment: existingDetails?.environment || '',
          lighting: existingDetails?.lighting || '',
          palette: existingDetails?.palette || '',
          continuity_before: existingDetails?.continuity_before || '',
          continuity_after: existingDetails?.continuity_after || '',
          audio_notes: existingDetails?.audio_notes || '',
          visual_pending: value.assetId === undefined ? (existingDetails?.visual_pending ?? 1) : Number(value.assetId === null),
        };
        for (const [field, item] of detailUpdates) details[field] = item;
        database.prepare(`INSERT INTO media_scene_details
          (scene_id, title, narrative_goal, dialogue, shot_type, camera_movement, action_description,
           environment, lighting, palette, continuity_before, continuity_after, audio_notes, visual_pending)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(scene_id) DO UPDATE SET title = excluded.title, narrative_goal = excluded.narrative_goal,
            dialogue = excluded.dialogue, shot_type = excluded.shot_type, camera_movement = excluded.camera_movement,
            action_description = excluded.action_description, environment = excluded.environment, lighting = excluded.lighting,
            palette = excluded.palette, continuity_before = excluded.continuity_before,
            continuity_after = excluded.continuity_after, audio_notes = excluded.audio_notes,
            visual_pending = excluded.visual_pending`)
          .run(sceneId, details.title, details.narrative_goal, details.dialogue, details.shot_type,
            details.camera_movement, details.action_description, details.environment, details.lighting,
            details.palette, details.continuity_before, details.continuity_after, details.audio_notes, details.visual_pending);
      }
    });
    try {
      transaction();
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (String(error.message).includes('UNIQUE constraint failed: media_scenes.project_id, media_scenes.scene_order')) {
        return res.status(409).json({ error: 'Ya existe una escena en esa posición.' });
      }
      throw error;
    }
    recalculateVoiceTimings(scene.project_id, timestampValue);
    return res.json({ project: getProjectJson(scene.project_id) });
  }

  function planErrorStatus(code) {
    if (code === 'external_operations_disabled') return 423;
    if (code === 'no_provider') return 503;
    if (code === 'script_too_long') return 422;
    if (code === 'project_rendering') return 409;
    if (code === 'cancelled') return 499;
    return 502;
  }

  function attachRequestAbort(req, res) {
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abort);
    res.once('close', abort);
    return {
      signal: controller.signal,
      dispose() {
        req.off('aborted', abort);
        res.off('close', abort);
      },
    };
  }

  async function requestScenePlan(projectId, settings, req, res) {
    const projectRow = getProject(projectId);
    if (!projectRow) return res.status(404).json({ error: 'No se encontró el proyecto.' });
    if (projectRow.status === 'rendering') return res.status(409).json({ error: 'No se puede planificar mientras el proyecto se está renderizando.' });
    if (!aiRouter?.generateStructured) {
      return res.status(503).json({ error: 'El servicio de planificación IA no está disponible en esta instancia.' });
    }
    const project = projectFromRow(projectRow, database);
    const abort = attachRequestAbort(req, res);
    try {
      validateSourceScript(project, settings);
      const result = await aiRouter.generateStructured({
        prompt: buildScenePlanningPrompt({ project, settings }),
        provider: settings.provider,
        task: 'media_planning',
        signal: abort.signal,
        validateResponse: (text) => validateAndNormalizeScenePlan(text, { project, settings }),
      });
      if (abort.signal.aborted) return;
      return res.json({
        plan: result.value,
        settings,
        provider: result.provider,
        model: result.model,
        attempts: result.attempts,
        fallbackReason: result.fallbackReason,
      });
    } catch (error) {
      if (abort.signal.aborted || error.code === 'cancelled') {
        if (!res.headersSent && !res.destroyed) return res.status(499).json({ error: 'La planificación fue cancelada.' });
        return;
      }
      const safe = safeProviderError(error);
      console.error(JSON.stringify({
        level: 'error',
        event: 'media_ai_plan_failed',
        projectId,
        errorCode: safe.code,
      }));
      return res.status(planErrorStatus(safe.code)).json({ error: safe.message, code: safe.code });
    } finally {
      abort.dispose();
    }
  }

  async function regeneratePlannedScene(projectId, sceneIndex, req, res) {
    const parsed = regenerateSceneRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'El plan que se va a regenerar no cumple la validación.' });
    const { settings, plan } = parsed.data;
    if (plan.durationSeconds !== settings.durationSeconds || plan.scenes.length !== settings.sceneCount ||
      !Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= plan.scenes.length) {
      return res.status(400).json({ error: 'La escena o sus restricciones no coinciden con el plan actual.' });
    }
    const projectRow = getProject(projectId);
    if (!projectRow) return res.status(404).json({ error: 'No se encontró el proyecto.' });
    if (projectRow.status === 'rendering') return res.status(409).json({ error: 'No se puede planificar mientras el proyecto se está renderizando.' });
    if (!aiRouter?.generateStructured) return res.status(503).json({ error: 'El servicio de planificación IA no está disponible en esta instancia.' });
    const project = projectFromRow(projectRow, database);
    const current = plan.scenes[sceneIndex];
    const abort = attachRequestAbort(req, res);
    try {
      validateSourceScript(project, settings);
      const result = await aiRouter.generateStructured({
        prompt: buildSceneRegenerationPrompt({ project, settings, plan, sceneIndex }),
        provider: settings.provider,
        task: 'media_scene_regeneration',
        signal: abort.signal,
        validateResponse: (text) => validateRegeneratedScene(text, {
          project,
          settings,
          durationSeconds: current.durationSeconds,
        }),
      });
      if (abort.signal.aborted) return;
      return res.json({
        scene: { ...result.value, id: current.id, order: current.order, durationSeconds: current.durationSeconds },
        provider: result.provider,
        model: result.model,
        attempts: result.attempts,
        fallbackReason: result.fallbackReason,
      });
    } catch (error) {
      if (abort.signal.aborted || error.code === 'cancelled') {
        if (!res.headersSent && !res.destroyed) return res.status(499).json({ error: 'La regeneración fue cancelada.' });
        return;
      }
      const safe = safeProviderError(error);
      console.error(JSON.stringify({
        level: 'error',
        event: 'media_ai_scene_regeneration_failed',
        projectId,
        sceneIndex,
        errorCode: safe.code,
      }));
      return res.status(planErrorStatus(safe.code)).json({ error: safe.message, code: safe.code });
    } finally {
      abort.dispose();
    }
  }

  function applyScenePlan(projectId, body, res) {
    const parsed = applyPlanRequestSchema.safeParse(body);
    if (!parsed.success) return res.status(400).json({ error: 'El plan revisado no cumple el esquema o sus duraciones no suman el objetivo.' });
    const { settings, plan, provider, model, preserveAssets } = parsed.data;
    if (plan.durationSeconds !== settings.durationSeconds || plan.scenes.length !== settings.sceneCount) {
      return res.status(400).json({ error: 'El plan revisado no coincide con la duración y cantidad de escenas elegidas.' });
    }
    const project = getProject(projectId);
    if (!project) return res.status(404).json({ error: 'No se encontró el proyecto.' });
    try {
      validateReviewedSpeech(plan, settings, project.source_script);
    } catch (error) {
      const safe = safeProviderError(error);
      return res.status(planErrorStatus(safe.code)).json({ error: safe.message, code: safe.code });
    }
    if (project.status === 'rendering') return res.status(409).json({ error: 'No se puede guardar un plan mientras el proyecto se está renderizando.' });
    const idsOutsideProject = database.prepare(`SELECT id FROM media_scenes WHERE id IN (${plan.scenes.map(() => '?').join(',')})
      AND project_id != ?`).all(...plan.scenes.map((scene) => scene.id), projectId);
    if (idsOutsideProject.length) return res.status(409).json({ error: 'Una escena del plan ya pertenece a otro proyecto; vuelve a generarlo.' });
    if (database.prepare("SELECT 1 FROM media_scene_voice_generations WHERE project_id = ? AND status IN ('queued', 'processing') LIMIT 1").get(projectId)) {
      return res.status(409).json({ error: 'Espera a que termine la generación de voz antes de reemplazar las escenas.' });
    }
    const existingScenes = database.prepare('SELECT id, scene_order, asset_id, visual_type FROM media_scenes WHERE project_id = ? ORDER BY scene_order').all(projectId);
    const assetsByOrder = new Map(existingScenes.map((scene) => [scene.scene_order, scene]));
    const now = timestamp();
    const transaction = database.transaction(() => {
      database.prepare('DELETE FROM media_scenes WHERE project_id = ?').run(projectId);
      const insertScene = database.prepare(`INSERT INTO media_scenes
        (id, project_id, scene_order, duration_seconds, planned_duration_seconds, duration_source,
         voice_text, subtitle_text, visual_description, visual_type, movement, transition,
         on_screen_text, visual_prompt, asset_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'estimated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertDetails = database.prepare(`INSERT INTO media_scene_details
        (scene_id, title, narrative_goal, dialogue, shot_type, camera_movement, action_description,
         environment, lighting, palette, continuity_before, continuity_after, audio_notes, visual_pending)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const scene of plan.scenes) {
        const previous = preserveAssets ? assetsByOrder.get(scene.order) : null;
        const assetId = previous?.asset_id || null;
        insertScene.run(
          scene.id, projectId, scene.order, scene.durationSeconds, scene.durationSeconds, scene.voiceText,
          scene.subtitleText, scene.visualDescription, assetId ? previous.visual_type : 'composition',
          scene.cameraMovement, scene.transition, scene.onScreenText, scene.visualDescription,
          assetId, now, now,
        );
        insertDetails.run(
          scene.id, scene.title, scene.narrativeGoal, scene.dialogue, scene.shotType,
          scene.cameraMovement, scene.actionDescription, scene.environment, scene.lighting,
          scene.palette, scene.continuityBefore, scene.continuityAfter, scene.audioNotes,
          Number(!assetId),
        );
      }
      database.prepare(`UPDATE media_projects SET duration_seconds = ?, status = 'draft', updated_at = ? WHERE id = ?`)
        .run(plan.durationSeconds, now, projectId);
      database.prepare(`INSERT INTO media_project_plans (project_id, narrative_goal, settings_json, provider, model, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET narrative_goal = excluded.narrative_goal,
          settings_json = excluded.settings_json, provider = excluded.provider, model = excluded.model,
          created_at = excluded.created_at`)
        .run(projectId, plan.narrativeGoal, JSON.stringify(settings), provider, model, now);
    });
    try {
      transaction();
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed: media_scenes.id')) {
        return res.status(409).json({ error: 'El identificador de una escena ya existe. Regenera el plan antes de guardarlo.' });
      }
      throw error;
    }
    recalculateVoiceTimings(projectId, now);
    return res.json({ project: getProjectJson(projectId) });
  }

  function listAssets(req, res) {
    const parsed = assetQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'El filtro de recursos no es válido.' });
    const clauses = [];
    const values = [];
    if (parsed.data.kind) {
      clauses.push('kind = ?');
      values.push(parsed.data.kind);
    }
    if (parsed.data.search?.trim()) {
      clauses.push('original_name LIKE ?');
      values.push(`%${parsed.data.search.trim()}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = database.prepare(`SELECT * FROM media_assets ${where} ORDER BY created_at DESC LIMIT 500`).all(...values);
    res.json(rows.map((row) => jsonAsset({ ...row, absolute_path: assetPath(row) })));
  }

  function runExecFile(binary, args, timeout) {
    return new Promise((resolvePromise, reject) => {
      execFileAsync(binary, args, {
        timeout,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      }).then(resolvePromise).catch(reject);
    });
  }

  function safeVoiceError(error) {
    const messages = {
      cancelled: 'La generación de voz fue cancelada.',
      tts_timeout: 'La generación de voz excedió el límite de tiempo.',
      tts_unavailable: 'Windows SAPI no está disponible para generar voz en este equipo.',
      tts_voice_unavailable: 'La voz seleccionada ya no está instalada.',
      tts_invalid_response: 'Windows SAPI devolvió un resultado inválido.',
      ffprobe_unavailable: 'FFprobe debe estar disponible para validar el audio generado.',
      invalid_audio: 'El motor no produjo un archivo WAV válido.',
      audio_too_large: 'El audio generado excede el límite local permitido.',
    };
    return messages[error?.code] || 'No se pudo generar o validar el audio local.';
  }

  async function executeVoiceGeneration(generationId) {
    const generation = database.prepare("SELECT * FROM media_scene_voice_generations WHERE id = ? AND status = 'queued'").get(generationId);
    if (!generation) return;
    const controller = new AbortController();
    activeVoiceControllers.set(generationId, controller);
    database.prepare(`UPDATE media_scene_voice_generations SET status = 'processing', updated_at = ?
      WHERE id = ? AND status = 'queued'`).run(timestamp(), generationId);
    const partialPath = join(temporaryDirectory, `voice-${generationId}.wav`);
    const finalPath = join(voicesDirectory, `${generationId}.wav`);
    let publishedPath = false;
    const task = (async () => {
      try {
        const scene = database.prepare(`SELECT s.id, s.voice_text, s.duration_seconds, p.status AS project_status
          FROM media_scenes s JOIN media_projects p ON p.id = s.project_id
          WHERE s.id = ? AND p.id = ?`).get(generation.scene_id, generation.project_id);
        if (!scene) throw Object.assign(new Error('La escena ya no existe.'), { code: 'scene_missing' });
        if (scene.project_status === 'rendering') throw Object.assign(new Error('El proyecto está renderizando.'), { code: 'project_rendering' });
        if (createHash('sha256').update(scene.voice_text).digest('hex') !== generation.source_sha256) {
          throw Object.assign(new Error('El texto cambió antes de generar el audio.'), { code: 'voice_text_changed' });
        }
        const ffmpegInfo = await detectFfmpeg();
        if (!ffmpegInfo.ffprobe.available) throw Object.assign(new Error('FFprobe no está disponible.'), { code: 'ffprobe_unavailable' });
        await voiceEngine.synthesize({
          text: generation.source_text,
          voiceId: generation.voice_id,
          rate: generation.rate,
          volume: generation.volume,
          outputPath: partialPath,
          signal: controller.signal,
        });
        if (controller.signal.aborted) throw Object.assign(new Error('Cancelada.'), { code: 'cancelled' });
        const file = await open(partialPath, 'r');
        const stats = await file.stat();
        await file.close();
        if (stats.size < 44) throw Object.assign(new Error('El WAV generado está vacío o truncado.'), { code: 'invalid_audio' });
        if (stats.size > 100 * 1024 * 1024) throw Object.assign(new Error('El WAV generado supera el límite.'), { code: 'audio_too_large' });
        const { stdout } = await runExecFile(ffprobePath(), [
          '-v', 'error',
          '-select_streams', 'a:0',
          '-show_entries', 'stream=codec_name,sample_rate,channels:format=format_name,duration',
          '-of', 'json',
          partialPath,
        ], 20_000);
        let metadata;
        try {
          metadata = JSON.parse(stdout);
        } catch {
          throw Object.assign(new Error('FFprobe devolvió metadatos inválidos.'), { code: 'invalid_audio' });
        }
        const audio = metadata.streams?.[0];
        const duration = Number(metadata.format?.duration);
        const sampleRate = Number(audio?.sample_rate);
        const channels = Number(audio?.channels);
        if (!audio?.codec_name || !Number.isFinite(duration) || duration < 0.05 || duration > 600 ||
          !Number.isFinite(sampleRate) || !Number.isFinite(channels) ||
          !String(metadata.format?.format_name || '').split(',').includes('wav')) {
          throw Object.assign(new Error('FFprobe no confirmó un WAV de audio reproducible.'), { code: 'invalid_audio' });
        }
        await rename(partialPath, finalPath);
        publishedPath = true;
        const completedAt = timestamp();
        const transaction = database.transaction(() => {
          const exists = database.prepare(`SELECT 1 FROM media_scene_voice_generations
            WHERE id = ? AND status = 'processing'`).get(generationId);
          const currentScene = database.prepare(`SELECT voice_text FROM media_scenes
            WHERE id = ? AND project_id = ?`).get(generation.scene_id, generation.project_id);
          if (!exists || !currentScene) throw Object.assign(new Error('La escena o la generación ya no existe.'), { code: 'scene_missing' });
          if (createHash('sha256').update(currentScene.voice_text).digest('hex') !== generation.source_sha256) {
            throw Object.assign(new Error('El texto cambió durante la generación.'), { code: 'voice_text_changed' });
          }
          database.prepare('UPDATE media_scene_voice_generations SET is_active = 0, updated_at = ? WHERE scene_id = ? AND is_active = 1')
            .run(completedAt, generation.scene_id);
          database.prepare(`UPDATE media_scene_voice_generations SET status = 'completed', is_active = 1,
            relative_path = ?, duration_seconds = ?, sample_rate = ?, channels = ?, size_bytes = ?,
            error_message = NULL, updated_at = ?, completed_at = ? WHERE id = ? AND status = 'processing'`)
            .run(`voices/${generationId}.wav`, duration, sampleRate, channels, stats.size, completedAt, completedAt, generationId);
        });
        transaction();
        recalculateVoiceTimings(generation.project_id, completedAt);
      } catch (error) {
        const cancelled = controller.signal.aborted || error?.code === 'cancelled';
        const status = cancelled ? 'cancelled' : 'failed';
        const message = safeVoiceError(error);
        database.prepare(`UPDATE media_scene_voice_generations SET status = ?, is_active = 0,
          error_message = ?, updated_at = ?, completed_at = ? WHERE id = ? AND status IN ('queued', 'processing')`)
          .run(status, message, timestamp(), timestamp(), generationId);
        if (!cancelled) console.error(JSON.stringify({
          level: 'error',
          event: 'media_voice_generation_failed',
          generationId,
          errorCode: error?.code || 'voice_generation_failed',
        }));
      } finally {
        await rm(partialPath, { force: true }).catch(() => {});
        if (publishedPath && database.prepare('SELECT 1 FROM media_scene_voice_generations WHERE id = ? AND status = ?').get(generationId, 'completed') === undefined) {
          await rm(finalPath, { force: true }).catch(() => {});
        }
        activeVoiceControllers.delete(generationId);
        activeVoiceTasks.delete(generationId);
      }
    })();
    activeVoiceTasks.set(generationId, task);
    await task;
  }

  async function startVoiceGeneration(projectId, sceneId, body, res) {
    const parsed = sceneVoiceRequestSchema.safeParse(body);
    if (!parsed.success) return res.status(400).json({ error: 'La voz, velocidad o volumen no son válidos.' });
    const project = getProject(projectId);
    if (!project) return res.status(404).json({ error: 'No se encontró el proyecto.' });
    if (project.status === 'rendering') return res.status(409).json({ error: 'No se puede generar voz mientras el proyecto se está renderizando.' });
    const scene = database.prepare('SELECT * FROM media_scenes WHERE id = ? AND project_id = ?').get(sceneId, projectId);
    if (!scene) return res.status(404).json({ error: 'No se encontró esa escena en el proyecto.' });
    const text = scene.voice_text.trim();
    if (!text) return res.status(422).json({ error: 'Esta escena no tiene narración. El diálogo no se asigna a una sola voz automáticamente.' });
    if (text.length > 3000) return res.status(422).json({ error: 'La narración supera el máximo de 3,000 caracteres.' });
    if (database.prepare("SELECT 1 FROM media_scene_voice_generations WHERE status IN ('queued', 'processing') LIMIT 1").get()) {
      return res.status(409).json({ error: 'Ya hay una generación de voz local en curso. Espera a que termine antes de iniciar otra.' });
    }
    const providers = await availableVoiceProviders();
    const engine = providers.find((provider) => provider.id === voiceEngine.id);
    if (!engine?.available) return res.status(503).json({ error: engine?.error || 'No hay voces locales disponibles en Windows.' });
    const id = parsed.data.voiceId;
    const available = engine.voices.find((voice) => voice.id === id);
    if (!available) {
      return res.status(400).json({ error: 'La voz seleccionada no está instalada o ya no está disponible.' });
    }
    const createdAt = timestamp();
    const generationId = randomUUID();
    database.prepare(`INSERT INTO media_scene_voice_generations
      (id, project_id, scene_id, provider, voice_id, language, rate, volume, source_text,
       source_sha256, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
      .run(
        generationId, projectId, sceneId, voiceEngine.id, available.id, available.language,
        parsed.data.rate, parsed.data.volume, scene.voice_text,
        createHash('sha256').update(scene.voice_text).digest('hex'), createdAt, createdAt,
      );
    setImmediate(() => { void executeVoiceGeneration(generationId); });
    const row = database.prepare('SELECT * FROM media_scene_voice_generations WHERE id = ?').get(generationId);
    return res.status(202).json({ generation: voiceGenerationJson(row, scene.voice_text) });
  }

  function cancelVoiceGeneration(generationId, res) {
    const generation = database.prepare('SELECT * FROM media_scene_voice_generations WHERE id = ?').get(generationId);
    if (!generation) return res.status(404).json({ error: 'No se encontró la generación de voz.' });
    if (!['queued', 'processing'].includes(generation.status)) {
      return res.status(409).json({ error: 'La generación de voz ya terminó.', generation: voiceGenerationJson(generation) });
    }
    if (generation.status === 'queued') {
      database.prepare(`UPDATE media_scene_voice_generations SET status = 'cancelled', error_message = ?,
        updated_at = ?, completed_at = ? WHERE id = ? AND status = 'queued'`)
        .run('La generación fue cancelada antes de comenzar.', timestamp(), timestamp(), generationId);
    } else {
      activeVoiceControllers.get(generationId)?.abort();
    }
    const updated = database.prepare('SELECT * FROM media_scene_voice_generations WHERE id = ?').get(generationId);
    return res.status(202).json({ generation: voiceGenerationJson(updated) });
  }

  function unlinkVoiceGeneration(generationId, res) {
    const generation = database.prepare('SELECT * FROM media_scene_voice_generations WHERE id = ?').get(generationId);
    if (!generation) return res.status(404).json({ error: 'No se encontró la generación de voz.' });
    if (generation.status !== 'completed' || !generation.is_active) {
      return res.status(409).json({ error: 'Solo puedes desvincular el audio activo de la escena.' });
    }
    const project = getProject(generation.project_id);
    if (project.status === 'rendering') {
      return res.status(409).json({ error: 'No se puede desvincular narración mientras el proyecto se está renderizando.' });
    }
    database.prepare('UPDATE media_scene_voice_generations SET is_active = 0, updated_at = ? WHERE id = ?')
      .run(timestamp(), generationId);
    recalculateVoiceTimings(generation.project_id, timestamp());
    return res.json({ project: getProjectJson(generation.project_id) });
  }

  function createSnapshot(projectId) {
    const row = getProject(projectId);
    if (!row) throw Object.assign(new Error('No se encontró el proyecto.'), { status: 404 });
    const project = projectFromRow(row, database);
    if (!project.scenes.length) throw Object.assign(new Error('El proyecto no tiene escenas.'), { status: 409 });
    const researchLinked = database.prepare(`SELECT 1 FROM research_sessions
      WHERE media_post_id = ? AND proposal_status = 'sent_to_media'`).get(row.post_id);
    if (researchLinked && project.scenes.some((scene) => !scene.asset)) {
      throw Object.assign(new Error('La propuesta de investigación no tiene recursos visuales asignados en todas sus escenas. Asigna imágenes o clips antes de renderizar.'), { status: 409 });
    }
    const scenes = project.scenes.map((scene) => {
      const asset = scene.asset ? getAsset(scene.asset.id) : null;
      if (scene.asset && (!asset || !existsSync(assetPath(asset)))) {
        throw Object.assign(new Error(`Falta el recurso asignado a la escena ${scene.order + 1}.`), { status: 409 });
      }
      const activeVoice = database.prepare(`SELECT * FROM media_scene_voice_generations
        WHERE scene_id = ? AND is_active = 1 AND status = 'completed'`).get(scene.id);
      const staleVoice = activeVoice && activeVoice.source_sha256 !== createHash('sha256').update(scene.voiceText).digest('hex');
      if (staleVoice) {
        throw Object.assign(new Error(`El audio de narración de la escena ${scene.order + 1} está desactualizado. Regénéralo o desvincúlalo antes de renderizar.`), { status: 409 });
      }
      if (activeVoice && (!Number.isFinite(activeVoice.duration_seconds) || activeVoice.duration_seconds <= 0)) {
        throw Object.assign(new Error(`FFprobe no confirmó la duración del WAV de la escena ${scene.order + 1}. Regenera o desvincula esta narración antes de renderizar.`), { status: 409 });
      }
      if (activeVoice && (!activeVoice.relative_path || !existsSync(safeRelativePath(mediaRoot, activeVoice.relative_path)))) {
        throw Object.assign(new Error(`No se encuentra el audio de narración de la escena ${scene.order + 1}. Regénéralo o desvincúlalo.`), { status: 409 });
      }
      return {
        order: scene.order,
        durationSeconds: scene.durationSeconds,
        subtitleText: scene.subtitleText,
        onScreenText: scene.onScreenText,
        visualType: scene.visualType,
        transition: scene.transition,
        assetPath: asset ? assetPath(asset) : null,
        assetKind: asset?.kind || null,
        voicePath: activeVoice ? safeRelativePath(mediaRoot, activeVoice.relative_path) : null,
        voiceDurationSeconds: activeVoice?.duration_seconds || null,
        voiceRequiredDurationSeconds: activeVoice
          ? getRequiredVoiceSceneDuration(activeVoice.duration_seconds, voiceSceneMarginSeconds)
          : null,
      };
    });
    const sceneVoices = scenes.filter((scene) => scene.voicePath);
    const voice = row.voice_asset_id ? getAsset(row.voice_asset_id) : null;
    const music = row.music_asset_id ? getAsset(row.music_asset_id) : null;
    for (const asset of [voice, music]) {
      if (asset && (!existsSync(assetPath(asset)) || asset.kind !== 'audio')) {
        throw Object.assign(new Error('Falta un recurso de audio asignado o su formato es inválido.'), { status: 409 });
      }
      if (sceneVoices.length && voice) {
        throw Object.assign(new Error('El proyecto tiene narración por escena y una grabación global. Desvincula una de las dos para evitar audio duplicado.'), { status: 409 });
      }
      if (sceneVoices.some((scene) => scene.voiceRequiredDurationSeconds > scene.durationSeconds)) {
        const scene = sceneVoices.find((item) => item.voiceRequiredDurationSeconds > item.durationSeconds);
        const requiredTotal = scenes.reduce((sum, item) => sum + Math.max(
          item.durationSeconds,
          item.voiceRequiredDurationSeconds || item.durationSeconds,
        ), 0);
        const limitMessage = requiredTotal > 180
          ? ` La duración necesaria estimada sería ${requiredTotal} s, por encima del límite actual de 180 s; reduce la duración base de otras escenas.`
          : '';
        throw Object.assign(new Error(
          `La narración de la escena ${scene.order + 1} dura ${scene.voiceDurationSeconds.toFixed(1)} s y necesita ${scene.voiceRequiredDurationSeconds} s con el margen de ${voiceSceneMarginSeconds} s; la escena dispone de ${scene.durationSeconds} s.${limitMessage} No se acelerará ni recortará automáticamente.`,
        ), { status: 409 });
      }
    }
    return {
      projectId,
      width: row.width,
      height: row.height,
      fps: row.fps,
      crf: row.crf,
      burnSubtitles: Boolean(row.burn_subtitles),
      durationSeconds: row.duration_seconds,
      scenes,
      voicePath: voice ? assetPath(voice) : null,
      musicPath: music ? assetPath(music) : null,
      expectsAudio: Boolean(sceneVoices.length || voice || music),
      voiceName: voice?.original_name || null,
      musicName: music?.original_name || null,
    };
  }

  function buildRenderArgs(snapshot, subtitlePath, partialPath, ffmpegInfo) {
    const args = ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats'];
    for (const scene of snapshot.scenes) {
      if (scene.assetKind === 'image') {
        args.push('-loop', '1', '-framerate', String(snapshot.fps), '-t', String(scene.durationSeconds), '-i', scene.assetPath);
      } else if (scene.assetKind === 'video') {
        args.push('-stream_loop', '-1', '-i', scene.assetPath);
      } else {
        args.push('-f', 'lavfi', '-i', `color=c=0x171324:s=${snapshot.width}x${snapshot.height}:r=${snapshot.fps}:d=${scene.durationSeconds}`);
      }
    }
    const videoInputs = [];
    const filters = [];
    snapshot.scenes.forEach((scene, index) => {
      const fadeIn = index > 0 && scene.transition === 'fade' ? Math.min(0.4, scene.durationSeconds / 3) : 0;
      const nextScene = snapshot.scenes[index + 1];
      const fadeOut = nextScene?.transition === 'fade' ? Math.min(0.4, scene.durationSeconds / 3) : 0;
      const effects = [
        fadeIn ? `fade=t=in:st=0:d=${fadeIn}` : '',
        fadeOut ? `fade=t=out:st=${Math.max(0, scene.durationSeconds - fadeOut)}:d=${fadeOut}` : '',
      ].filter(Boolean);
      filters.push(`[${index}:v]scale=${snapshot.width}:${snapshot.height}:force_original_aspect_ratio=increase,crop=${snapshot.width}:${snapshot.height},fps=${snapshot.fps},setsar=1,trim=duration=${scene.durationSeconds},setpts=PTS-STARTPTS${effects.length ? `,${effects.join(',')}` : ''}[v${index}]`);
      videoInputs.push(`[v${index}]`);
    });
    filters.push(`${videoInputs.join('')}concat=n=${snapshot.scenes.length}:v=1:a=0[base]`);
    if (snapshot.burnSubtitles && snapshot.scenes.some((scene) => scene.subtitleText.trim() || scene.onScreenText?.trim())) {
      if (!ffmpegInfo.ffmpeg.subtitles) {
        throw Object.assign(new Error('Esta compilación de FFmpeg no incluye el filtro de subtítulos. Desactiva “Integrar subtítulos” o instala una compilación con libass.'), { code: 'subtitles_unsupported' });
      }
      const path = escapedFilterPath(subtitlePath);
      filters.push(`[base]subtitles=filename='${path}'[vout]`);
    } else {
      filters.push('[base]null[vout]');
    }
    const hasSceneVoices = snapshot.scenes.some((scene) => scene.voicePath);
    const audioInputs = [];
    if (hasSceneVoices) {
      snapshot.scenes.forEach((scene) => {
        const inputIndex = snapshot.scenes.length + audioInputs.length;
        if (scene.voicePath) {
          args.push('-i', scene.voicePath);
          audioInputs.push({ inputIndex, kind: 'scene_voice', duration: scene.durationSeconds });
        } else {
          args.push('-f', 'lavfi', '-t', String(scene.durationSeconds), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
          audioInputs.push({ inputIndex, kind: 'silence', duration: scene.durationSeconds });
        }
      });
    } else if (snapshot.voicePath) {
      const inputIndex = snapshot.scenes.length + audioInputs.length;
      args.push('-i', snapshot.voicePath);
      audioInputs.push({ inputIndex, kind: 'voice' });
    }
    if (snapshot.musicPath) {
      const inputIndex = snapshot.scenes.length + audioInputs.length;
      args.push('-stream_loop', '-1', '-i', snapshot.musicPath);
      audioInputs.push({ inputIndex, kind: 'music' });
    }
    const duration = snapshot.durationSeconds;
    if (hasSceneVoices) {
      const voiceLabels = [];
      audioInputs.filter((input) => input.kind !== 'music').forEach((input, index) => {
        const sceneDuration = input.duration;
        const label = `voicepart${index}`;
        filters.push(`[${input.inputIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${sceneDuration},atrim=duration=${sceneDuration},asetpts=PTS-STARTPTS[${label}]`);
        voiceLabels.push(`[${label}]`);
      });
      filters.push(`${voiceLabels.join('')}concat=n=${voiceLabels.length}:v=0:a=1[voice]`);
      const music = audioInputs.find((input) => input.kind === 'music');
      if (music) {
        filters.push(`[${music.inputIndex}:a]aresample=48000,atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=0.18[music]`);
        filters.push('[voice][music]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[aout]');
      } else {
        filters.push('[voice]anull[aout]');
      }
    } else if (audioInputs.length === 1) {
      const input = audioInputs[0];
      filters.push(`[${input.inputIndex}:a]atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=${input.kind === 'music' ? 0.22 : 1}[aout]`);
    } else if (audioInputs.length === 2) {
      const voice = audioInputs.find((input) => input.kind === 'voice');
      const music = audioInputs.find((input) => input.kind === 'music');
      filters.push(`[${voice.inputIndex}:a]atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=1[voice]`);
      filters.push(`[${music.inputIndex}:a]atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=0.18[music]`);
      filters.push('[voice][music]amix=inputs=2:duration=longest:dropout_transition=0,alimiter=limit=0.95[aout]');
    }
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-t', String(duration), '-r', String(snapshot.fps),
      '-c:v', ffmpegInfo.ffmpeg.h264 ? 'libx264' : 'mpeg4');
    if (ffmpegInfo.ffmpeg.h264) args.push('-crf', String(snapshot.crf));
    else args.push('-q:v', String(Math.max(2, Math.min(31, Math.round(snapshot.crf / 2)))));
    args.push('-pix_fmt', 'yuv420p', '-movflags', '+faststart');
    if (audioInputs.length) {
      if (!ffmpegInfo.ffmpeg.aac) throw Object.assign(new Error('FFmpeg no dispone de un codificador AAC para los recursos de audio del proyecto.'), { code: 'aac_unsupported' });
      args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
    } else {
      args.push('-an');
    }
    args.push(partialPath);
    return args;
  }

  function spawnProcess(binary, args, handlers = {}) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      let lineBuffer = '';
      let timeout;
      const finish = (error, result) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolvePromise(result);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        lineBuffer += chunk;
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() || '';
        for (const line of lines) handlers.progress?.(line);
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-32_000);
      });
      child.once('error', (error) => finish(error));
      child.once('close', (code, signal) => {
        if (code === 0) finish(null, { stderr });
        else {
          const error = new Error(stderr || `El proceso multimedia finalizó con código ${code ?? signal}.`);
          error.code = code === null ? 'process_terminated' : 'ffmpeg_failed';
          finish(error);
        }
      });
      timeout = setTimeout(() => {
        child.kill();
        const error = new Error('El proceso multimedia excedió el tiempo máximo permitido.');
        error.code = 'render_timeout';
        handlers.timeout?.();
        finish(error);
      }, timeoutMs);
      handlers.started?.(child);
    });
  }

  function updateJob(id, status, stage, progress, extra = {}) {
    const columns = { status, stage, progress, updated_at: timestamp(), ...extra };
    const updates = Object.entries(columns);
    database.prepare(`UPDATE media_render_jobs SET ${updates.map(([field]) => `${field} = ?`).join(', ')} WHERE id = ?`)
      .run(...updates.map(([, value]) => value), id);
  }

  async function executeJob(job) {
    const startedAt = Date.now();
    let partialPath;
    let subtitlePath;
    let subtitleAssPath;
    let subtitleExportPath;
    let finalPath;
    let snapshot;
    async function cleanupRenderFile(path) {
      if (!path) return;
      try {
        await rm(path, { force: true });
      } catch (error) {
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'media_render_temp_cleanup_failed',
          jobId: job.id,
          code: error.code || 'cleanup_failed',
        }));
      }
    }
    try {
      updateJob(job.id, 'preparing', 'Comprobando herramientas y preparando archivos', null, { started_at: timestamp() });
      const diagnosticInfo = await detectFfmpeg();
      if (cancelling.has(job.id)) throw Object.assign(new Error('El trabajo se canceló.'), { code: 'cancelled' });
      if (!diagnosticInfo.ffmpeg.available || !diagnosticInfo.ffprobe.available) {
        throw Object.assign(new Error(!diagnosticInfo.ffmpeg.available ? diagnosticInfo.ffmpeg.error : diagnosticInfo.ffprobe.error), { code: 'ffmpeg_unavailable' });
      }
      snapshot = JSON.parse(job.config_json);
      partialPath = join(temporaryDirectory, `${job.id}.partial.mp4`);
      subtitlePath = join(temporaryDirectory, `${job.id}.srt`);
      finalPath = join(exportsDirectory, `${job.id}.mp4`);
      const subtitleText = buildSrt(snapshot.scenes, { width: snapshot.width, height: snapshot.height });
      await writeFile(subtitlePath, subtitleText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      if (snapshot.burnSubtitles && snapshot.scenes.some((scene) => scene.subtitleText.trim() || scene.onScreenText?.trim())) {
        subtitleAssPath = join(temporaryDirectory, `${job.id}.ass`);
        const subtitleAss = buildSubtitleAss(snapshot.scenes, { width: snapshot.width, height: snapshot.height });
        await writeFile(subtitleAssPath, subtitleAss, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      }
      const args = buildRenderArgs(snapshot, subtitleAssPath || subtitlePath, partialPath, diagnosticInfo);
      if (cancelling.has(job.id)) throw Object.assign(new Error('El trabajo se canceló.'), { code: 'cancelled' });
      console.info(JSON.stringify({
        level: 'info',
        event: 'media_render_started',
        jobId: job.id,
        projectId: job.project_id,
        sceneCount: snapshot.scenes.length,
        audioInputCount: snapshot.scenes.filter((scene) => scene.voicePath).length +
          Number(Boolean(snapshot.voicePath)) + Number(Boolean(snapshot.musicPath)),
        width: snapshot.width,
        height: snapshot.height,
        durationSeconds: snapshot.durationSeconds,
      }));
      updateJob(job.id, 'processing', 'Renderizando con FFmpeg', null);
      let reportedTime = 0;
      await spawnProcess(ffmpegPath(), args, {
        started: (child) => {
          running.set(job.id, child);
          if (cancelling.has(job.id)) child.kill();
        },
        progress: (line) => {
          const [key, value] = line.split('=', 2);
          if (key === 'out_time') {
            const seconds = ffmpegProgressTime(value);
            if (seconds !== null) reportedTime = seconds;
          } else if (key === 'out_time_us' || key === 'out_time_ms') {
            const microseconds = Number(value);
            if (Number.isFinite(microseconds)) reportedTime = microseconds / 1_000_000;
          } else if (key === 'progress' && value === 'continue') {
            const percent = Math.min(99, Math.max(0, (reportedTime / snapshot.durationSeconds) * 100));
            updateJob(job.id, 'processing', 'Renderizando con FFmpeg', percent);
          }
        },
      });
      running.delete(job.id);
      if (cancelling.has(job.id)) throw Object.assign(new Error('El trabajo se canceló.'), { code: 'cancelled' });
      updateJob(job.id, 'validating', 'Validando el video exportado', null);
      await rename(partialPath, finalPath);
      const probe = await runExecFile(ffprobePath(), [
        '-v', 'error', '-show_entries', 'format=format_name,duration,size:stream=codec_type,codec_name,width,height',
        '-of', 'json', finalPath,
      ], 20_000);
      if (cancelling.has(job.id)) throw Object.assign(new Error('El trabajo se canceló.'), { code: 'cancelled' });
      const metadata = JSON.parse(probe.stdout);
      const video = metadata.streams?.find((stream) => stream.codec_type === 'video');
      const audio = metadata.streams?.find((stream) => stream.codec_type === 'audio');
      const duration = Number(metadata.format?.duration);
      const size = Number(metadata.format?.size);
      if (!video || !Number.isFinite(duration) || !Number.isFinite(size) || size <= 0 ||
        !String(metadata.format?.format_name).split(',').includes('mp4') ||
        (snapshot.expectsAudio && (!audio || audio.codec_name !== 'aac')) ||
        video.width !== snapshot.width || video.height !== snapshot.height ||
        Math.abs(duration - snapshot.durationSeconds) > 0.75) {
        throw Object.assign(new Error('FFprobe no confirmó un MP4 legible con video, audio esperado, duración y resolución solicitados.'), { code: 'export_validation_failed' });
      }
      const exportId = randomUUID();
      const outputRelative = `exports/${job.id}.mp4`;
      const subtitleRelative = `exports/${job.id}.srt`;
      subtitleExportPath = join(exportsDirectory, `${job.id}.srt`);
      await rename(subtitlePath, subtitleExportPath);
      const completedAt = timestamp();
      const transaction = database.transaction(() => {
        database.prepare(`INSERT INTO media_exports
          (id, project_id, job_id, relative_path, subtitle_path, duration_seconds, width, height, video_codec, audio_codec, size_bytes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          exportId, job.project_id, job.id, outputRelative, subtitleRelative,
          duration, video.width, video.height, video.codec_name, audio?.codec_name || null, size, completedAt,
        );
        database.prepare(`UPDATE media_render_jobs SET status = 'completed', stage = 'Validación técnica completada; revisión visual pendiente',
          progress = 100, output_relpath = ?, completed_at = ?, duration_ms = ?, updated_at = ? WHERE id = ?`)
          .run(outputRelative, completedAt, Date.now() - startedAt, completedAt, job.id);
        database.prepare(`UPDATE media_projects SET status = 'completed', updated_at = ? WHERE id = ?`)
          .run(completedAt, job.project_id);
      });
      transaction();
      console.info(JSON.stringify({ level: 'info', event: 'media_render_completed', jobId: job.id, exportId, durationSeconds: duration }));
    } catch (error) {
      running.delete(job.id);
      const cancelled = cancelling.has(job.id) || error.code === 'cancelled';
      const status = cancelled ? 'cancelled' : 'failed';
      const safeMessage = cancelled
        ? 'El trabajo se canceló.'
        : error.code === 'ffmpeg_unavailable'
          ? `${error.message} Instala FFmpeg/FFprobe o configura las rutas en .env.`
          : safeError(error);
      await cleanupRenderFile(finalPath);
      finalPath = undefined;
      await cleanupRenderFile(subtitleExportPath);
      subtitleExportPath = undefined;
      await cleanupRenderFile(partialPath);
      partialPath = undefined;
      await cleanupRenderFile(subtitlePath);
      subtitlePath = undefined;
      await cleanupRenderFile(subtitleAssPath);
      subtitleAssPath = undefined;
      const completedAt = timestamp();
      updateJob(job.id, status, cancelled ? 'Cancelado' : 'Falló', null, {
        error_message: safeMessage,
        completed_at: completedAt,
        duration_ms: Date.now() - startedAt,
      });
      database.prepare(`UPDATE media_projects SET status = ?, updated_at = ? WHERE id = ? AND status = 'rendering'`)
        .run(cancelled ? 'draft' : 'failed', completedAt, job.project_id);
      console[cancelled ? 'info' : 'error'](JSON.stringify({
        level: cancelled ? 'info' : 'error',
        event: cancelled ? 'media_render_cancelled' : 'media_render_failed',
        jobId: job.id,
        code: error.code || (cancelled ? 'cancelled' : 'render_error'),
        message: safeMessage,
      }));
    } finally {
      running.delete(job.id);
      cancelling.delete(job.id);
      await cleanupRenderFile(partialPath);
      await cleanupRenderFile(subtitlePath);
      await cleanupRenderFile(subtitleAssPath);
    }
  }

  function processQueue() {
    if (pumping) return;
    pumping = true;
    try {
      while (running.size < maxConcurrent) {
        const job = database.prepare(`SELECT * FROM media_render_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`).get();
        if (!job) break;
        const claim = database.prepare(`UPDATE media_render_jobs SET status = 'preparing', stage = 'Preparando', started_at = ?, updated_at = ?
          WHERE id = ? AND status = 'queued'`).run(timestamp(), timestamp(), job.id);
        if (!claim.changes) continue;
        database.prepare(`UPDATE media_projects SET status = 'rendering', updated_at = ? WHERE id = ?`).run(timestamp(), job.project_id);
        const executing = { ...job, status: 'preparing' };
        running.set(job.id, null);
        const task = executeJob(executing);
        activeTasks.set(job.id, task);
        void task.then(() => activeTasks.delete(job.id));
      }
    } finally {
      pumping = false;
    }
  }

  function startRender(projectId, res) {
    const project = getProject(projectId);
    if (!project) return res.status(404).json({ error: 'No se encontró el proyecto.' });
    if (database.prepare("SELECT 1 FROM media_scene_voice_generations WHERE project_id = ? AND status IN ('queued', 'processing') LIMIT 1").get(projectId)) {
      return res.status(409).json({ error: 'Espera a que termine la generación de voz antes de iniciar el renderizado.' });
    }
    const hasAiPlan = database.prepare('SELECT 1 FROM media_project_plans WHERE project_id = ?').get(projectId);
    if (hasAiPlan) {
      const pending = database.prepare(`SELECT COUNT(*) AS count FROM media_scenes
        WHERE project_id = ? AND asset_id IS NULL`).get(projectId).count;
      if (pending) {
        return res.status(409).json({
          error: `${pending} escena(s) del plan IA siguen pendientes de material visual. Asigna recursos de imagen o video de tu biblioteca antes de renderizar.`,
        });
      }
    }
    let snapshot;
    try {
      snapshot = createSnapshot(projectId);
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }
    const existing = database.prepare(`SELECT * FROM media_render_jobs WHERE project_id = ?
      AND status IN ('queued', 'preparing', 'processing', 'validating') ORDER BY created_at DESC LIMIT 1`).get(projectId);
    if (existing) return res.status(200).json({ job: publicJob(existing), existing: true });
    const jobId = randomUUID();
    const createdAt = timestamp();
    database.prepare(`INSERT INTO media_render_jobs (id, project_id, status, stage, progress, config_json, attempt, created_at, updated_at)
      VALUES (?, ?, 'queued', 'En cola', NULL, ?, 1, ?, ?)`)
      .run(jobId, projectId, JSON.stringify(snapshot), createdAt, createdAt);
    const job = database.prepare('SELECT * FROM media_render_jobs WHERE id = ?').get(jobId);
    processQueue();
    return res.status(202).json({ job: publicJob(job), existing: false });
  }

  function retryJob(jobId, res) {
    const job = database.prepare('SELECT * FROM media_render_jobs WHERE id = ?').get(jobId);
    if (!job) return res.status(404).json({ error: 'No se encontró el trabajo.' });
    if (job.status !== 'failed') return res.status(409).json({ error: 'Solo se puede reintentar un trabajo fallido.' });
    const active = database.prepare(`SELECT id FROM media_render_jobs WHERE project_id = ?
      AND status IN ('queued', 'preparing', 'processing', 'validating')`).get(job.project_id);
    if (active) return res.status(409).json({ error: 'Ya existe un trabajo activo para este proyecto.' });
    const id = randomUUID();
    const createdAt = timestamp();
    database.prepare(`INSERT INTO media_render_jobs (id, project_id, status, stage, progress, config_json, attempt, created_at, updated_at)
      VALUES (?, ?, 'queued', 'En cola', NULL, ?, ?, ?, ?)`)
      .run(id, job.project_id, job.config_json, job.attempt + 1, createdAt, createdAt);
    processQueue();
    return res.status(202).json({ job: publicJob(database.prepare('SELECT * FROM media_render_jobs WHERE id = ?').get(id)) });
  }

  function cancelJob(jobId, res) {
    const job = database.prepare('SELECT * FROM media_render_jobs WHERE id = ?').get(jobId);
    if (!job) return res.status(404).json({ error: 'No se encontró el trabajo.' });
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      return res.status(409).json({ error: 'El trabajo ya terminó y no se puede cancelar.', job: publicJob(job) });
    }
    if (job.status === 'queued') {
      updateJob(jobId, 'cancelled', 'Cancelado antes de iniciar', null, { completed_at: timestamp() });
      database.prepare(`UPDATE media_projects SET status = 'draft', updated_at = ? WHERE id = ?`)
        .run(timestamp(), job.project_id);
    } else {
      cancelling.add(jobId);
      const child = running.get(jobId);
      if (child) child.kill();
    }
    return res.status(202).json({ job: publicJob(database.prepare('SELECT * FROM media_render_jobs WHERE id = ?').get(jobId)) });
  }

  function recoverInterruptedJobs() {
    const interrupted = database.prepare(`SELECT id, project_id FROM media_render_jobs
      WHERE status IN ('preparing', 'processing', 'validating')`).all();
    const transaction = database.transaction(() => {
      for (const job of interrupted) {
        updateJob(job.id, 'queued', 'Recuperado tras reiniciar; esperando renderizado', null);
        database.prepare(`UPDATE media_projects SET status = 'draft', updated_at = ? WHERE id = ?`).run(timestamp(), job.project_id);
      }
    });
    transaction();
    rmSync(temporaryDirectory, { recursive: true, force: true });
    mkdirSync(temporaryDirectory, { recursive: true });
    const interruptedVoices = database.prepare(`UPDATE media_scene_voice_generations SET status = 'failed',
      is_active = 0, error_message = ?, updated_at = ?, completed_at = ?
      WHERE status IN ('queued', 'processing')`).run(
      'La API se reinició antes de terminar esta generación. El audio anterior se conservó.',
      timestamp(),
      timestamp(),
    ).changes;
    return interrupted.length + interruptedVoices;
  }

  function getJobs() {
    return database.prepare('SELECT * FROM media_render_jobs ORDER BY created_at DESC LIMIT 100').all().map(publicJob);
  }

  function publicExport(row) {
    return {
      id: row.id,
      projectId: row.project_id,
      projectTitle: row.project_title,
      durationSeconds: row.duration_seconds,
      width: row.width,
      height: row.height,
      videoCodec: row.video_codec,
      audioCodec: row.audio_codec,
      sizeBytes: row.size_bytes,
      technicalValidationStatus: 'ffprobe_passed',
      visualReviewStatus: row.visual_review_status,
      visualReviewedAt: row.visual_reviewed_at,
      visualReviewNote: row.visual_review_note,
      createdAt: row.created_at,
      fileUrl: `/media/exports/${row.id}/file?inline=true`,
      subtitleUrl: row.subtitle_path ? `/media/exports/${row.id}/subtitles` : null,
    };
  }

  function getExports() {
    return database.prepare(`SELECT e.*, p.title AS project_title FROM media_exports e
      JOIN media_projects p ON p.id = e.project_id ORDER BY e.created_at DESC LIMIT 200`).all().map(publicExport);
  }

  function registerUploadRoute(app) {
    app.put('/api/v1/media/assets', (req, res, next) => {
      void importAsset(req, res).catch(next);
    });
  }

  function registerRoutes(app, mediaPlanLimiter, mediaVoiceLimiter) {
    app.get('/api/v1/media/diagnostics', async (_req, res, next) => {
      try {
        res.json(await diagnostic());
      } catch (error) {
        next(error);
      }
    });
    app.get('/api/v1/media/projects', (_req, res) => {
      const rows = database.prepare('SELECT * FROM media_projects ORDER BY updated_at DESC LIMIT 100').all();
      res.json(rows.map((row) => getProjectJson(row.id)));
    });
    app.post('/api/v1/media/projects', (req, res) => startProject(req.body, res));
    app.get('/api/v1/media/projects/:id', (req, res) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de proyecto inválido.' });
      const project = getProjectJson(req.params.id);
      if (!project) return res.status(404).json({ error: 'No se encontró el proyecto.' });
      res.json(project);
    });
    app.patch('/api/v1/media/projects/:id', (req, res) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de proyecto inválido.' });
      return patchProject(req.params.id, req.body, res);
    });
    app.patch('/api/v1/media/scenes/:id', (req, res) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de escena inválido.' });
      return patchScene(req.params.id, req.body, res);
    });
    app.post('/api/v1/media/projects/:id/plan', mediaPlanLimiter || ((_req, _res, next) => next()), (req, res, next) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de proyecto inválido.' });
      const parsed = planRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Revisa duración, escenas, público y opciones de planificación.' });
      void requestScenePlan(req.params.id, parsed.data.settings, req, res).catch(next);
    });
    app.post('/api/v1/media/projects/:id/plan/scenes/:sceneIndex/regenerate', mediaPlanLimiter || ((_req, _res, next) => next()), (req, res, next) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de proyecto inválido.' });
      const sceneIndex = Number(req.params.sceneIndex);
      if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex > 11) return res.status(400).json({ error: 'Índice de escena inválido.' });
      void regeneratePlannedScene(req.params.id, sceneIndex, req, res).catch(next);
    });
    app.put('/api/v1/media/projects/:id/plan', (req, res) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de proyecto inválido.' });
      return applyScenePlan(req.params.id, req.body, res);
    });
    app.post('/api/v1/media/projects/:id/scenes/:sceneId/voice', mediaVoiceLimiter || ((_req, _res, next) => next()), (req, res, next) => {
      if (!projectIdSchema.safeParse(req.params.id).success || !projectIdSchema.safeParse(req.params.sceneId).success) {
        return res.status(400).json({ error: 'El identificador del proyecto o escena no es válido.' });
      }
      void startVoiceGeneration(req.params.id, req.params.sceneId, req.body, res).catch(next);
    });
    app.get('/api/v1/media/voice-generations/:id', (req, res) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'El identificador de voz no es válido.' });
      const row = database.prepare(`SELECT g.*, s.voice_text FROM media_scene_voice_generations g
        JOIN media_scenes s ON s.id = g.scene_id WHERE g.id = ?`).get(req.params.id);
      if (!row) return res.status(404).json({ error: 'No se encontró la generación de voz.' });
      res.json({ generation: voiceGenerationJson(row, row.voice_text) });
    });
    app.post('/api/v1/media/voice-generations/:id/cancel', (req, res) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'El identificador de voz no es válido.' });
      return cancelVoiceGeneration(req.params.id, res);
    });
    app.post('/api/v1/media/voice-generations/:id/unlink', (req, res) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'El identificador de voz no es válido.' });
      return unlinkVoiceGeneration(req.params.id, res);
    });
    app.get('/api/v1/media/voice-generations/:id/file', (req, res, next) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'El identificador de voz no es válido.' });
      const voice = database.prepare(`SELECT * FROM media_scene_voice_generations
        WHERE id = ? AND status = 'completed'`).get(req.params.id);
      if (!voice || !voice.relative_path) return res.status(404).json({ error: 'No se encontró el archivo de voz validado.' });
      const path = safeRelativePath(mediaRoot, voice.relative_path);
      if (!existsSync(path)) return res.status(410).json({ error: 'El archivo de voz ya no existe. Regenera la narración.' });
      res.type('audio/wav');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'no-store');
      res.sendFile(path, (error) => { if (error && !res.headersSent) next(error); });
    });
    app.get('/api/v1/media/assets', listAssets);
    app.get('/api/v1/media/assets/:id/content', (req, res, next) => {
      if (!assetIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de recurso inválido.' });
      const asset = getAsset(req.params.id);
      if (!asset) return res.status(404).json({ error: 'No se encontró el recurso.' });
      const path = assetPath(asset);
      if (!existsSync(path)) return res.status(410).json({ error: 'El archivo importado ya no existe en la biblioteca.' });
      res.type(asset.mime_type);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
      res.sendFile(path, (error) => { if (error && !res.headersSent) next(error); });
    });
    app.delete('/api/v1/media/assets/:id', (req, res) => {
      if (!assetIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de recurso inválido.' });
      if (req.query.confirm !== 'true') return res.status(400).json({ error: 'Confirma la eliminación de este recurso.' });
      const asset = getAsset(req.params.id);
      if (!asset) return res.status(404).json({ error: 'No se encontró el recurso.' });
      const referenced = database.prepare(`SELECT
        (SELECT COUNT(*) FROM media_scenes WHERE asset_id = ?) +
        (SELECT COUNT(*) FROM media_projects WHERE voice_asset_id = ? OR music_asset_id = ?) AS count`)
        .get(req.params.id, req.params.id, req.params.id).count;
      if (referenced > 0) return res.status(409).json({ error: 'El recurso está asignado a uno o más proyectos. Reemplázalo antes de eliminarlo.' });
      const path = assetPath(asset);
      const transaction = database.transaction(() => database.prepare('DELETE FROM media_assets WHERE id = ?').run(req.params.id));
      transaction();
      rm(path, { force: true }).catch((error) => console.error(JSON.stringify({ level: 'error', event: 'media_asset_cleanup_failed', assetId: asset.id, code: error.code || 'cleanup_error' })));
      return res.status(204).end();
    });
    app.get('/api/v1/media/jobs', (_req, res) => res.json(getJobs()));
    app.get('/api/v1/media/jobs/:id', (req, res) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de trabajo inválido.' });
      const job = database.prepare('SELECT * FROM media_render_jobs WHERE id = ?').get(req.params.id);
      if (!job) return res.status(404).json({ error: 'No se encontró el trabajo.' });
      res.json(publicJob(job));
    });
    app.post('/api/v1/media/projects/:id/render', (req, res) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de proyecto inválido.' });
      return startRender(req.params.id, res);
    });
    app.post('/api/v1/media/jobs/:id/cancel', (req, res) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de trabajo inválido.' });
      return cancelJob(req.params.id, res);
    });
    app.post('/api/v1/media/jobs/:id/retry', (req, res) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de trabajo inválido.' });
      return retryJob(req.params.id, res);
    });
    app.get('/api/v1/media/exports', (_req, res) => res.json(getExports()));
    app.post('/api/v1/media/exports/:id/visual-review', (req, res) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de exportación inválido.' });
      const parsed = visualReviewSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'La revisión debe registrar approved o needs_changes y una nota de hasta 1,000 caracteres.' });
      const item = database.prepare('SELECT * FROM media_exports WHERE id = ?').get(req.params.id);
      if (!item) return res.status(404).json({ error: 'No se encontró la exportación.' });
      const path = safeRelativePath(mediaRoot, item.relative_path);
      if (!existsSync(path)) return res.status(410).json({ error: 'El archivo exportado no está disponible para revisión.' });
      const reviewedAt = timestamp();
      database.prepare(`UPDATE media_exports SET visual_review_status = ?, visual_reviewed_at = ?, visual_review_note = ?
        WHERE id = ?`).run(parsed.data.status, reviewedAt, parsed.data.note || null, item.id);
      const row = database.prepare(`SELECT e.*, p.title AS project_title FROM media_exports e
        JOIN media_projects p ON p.id = e.project_id WHERE e.id = ?`).get(item.id);
      const reviewed = row ? publicExport(row) : null;
      if (!reviewed) throw new Error('La revisión visual se guardó, pero la exportación dejó de estar disponible.');
      return res.json({ export: reviewed });
    });
    app.get('/api/v1/media/exports/:id/file', (req, res, next) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de exportación inválido.' });
      const item = database.prepare('SELECT * FROM media_exports WHERE id = ?').get(req.params.id);
      if (!item) return res.status(404).json({ error: 'No se encontró la exportación.' });
      const path = safeRelativePath(mediaRoot, item.relative_path);
      if (!existsSync(path)) return res.status(410).json({ error: 'El archivo exportado no está disponible en disco.' });
      if (req.query.inline === 'true') {
        res.type('video/mp4');
        res.set('X-Content-Type-Options', 'nosniff');
        res.sendFile(path, (error) => { if (error && !res.headersSent) next(error); });
      } else {
        res.download(path, `${item.id}.mp4`, (error) => { if (error && !res.headersSent) next(error); });
      }
    });
    app.get('/api/v1/media/exports/:id/subtitles', (req, res, next) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de exportación inválido.' });
      const item = database.prepare('SELECT * FROM media_exports WHERE id = ?').get(req.params.id);
      if (!item?.subtitle_path) return res.status(404).json({ error: 'No se encontraron subtítulos exportados.' });
      const path = safeRelativePath(mediaRoot, item.subtitle_path);
      if (!existsSync(path)) return res.status(410).json({ error: 'El archivo SRT no está disponible en disco.' });
      res.type('application/x-subrip');
      res.sendFile(path, (error) => { if (error && !res.headersSent) next(error); });
    });
    app.delete('/api/v1/media/projects/:id', (req, res) => {
      if (!projectIdSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Identificador de proyecto inválido.' });
      if (req.query.confirm !== 'true') return res.status(400).json({ error: 'Confirma la eliminación de este proyecto.' });
      const project = getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'No se encontró el proyecto.' });
      if (project.status === 'rendering') return res.status(409).json({ error: 'Cancela el renderizado antes de eliminar el proyecto.' });
      if (database.prepare("SELECT 1 FROM media_scene_voice_generations WHERE project_id = ? AND status IN ('queued', 'processing') LIMIT 1").get(req.params.id)) {
        return res.status(409).json({ error: 'Espera a que termine o cancela la generación de voz antes de eliminar el proyecto.' });
      }
      if (database.prepare('SELECT 1 FROM media_exports WHERE project_id = ? LIMIT 1').get(req.params.id)) {
        return res.status(409).json({ error: 'El proyecto conserva exportaciones; archívalo para mantener su historial.' });
      }
      database.prepare('DELETE FROM media_projects WHERE id = ?').run(req.params.id);
      return res.status(204).end();
    });
  }

  async function shutdown() {
    for (const id of running.keys()) cancelling.add(id);
    for (const child of running.values()) child?.kill();
    for (const [id, controller] of activeVoiceControllers) {
      const row = database.prepare("SELECT status FROM media_scene_voice_generations WHERE id = ?").get(id);
      if (row?.status === 'queued') {
        database.prepare(`UPDATE media_scene_voice_generations SET status = 'cancelled', error_message = ?,
          updated_at = ?, completed_at = ? WHERE id = ? AND status = 'queued'`)
          .run('La API se está cerrando.', timestamp(), timestamp(), id);
      }
      controller.abort();
    }
    database.prepare(`UPDATE media_scene_voice_generations SET status = 'cancelled', error_message = ?,
      updated_at = ?, completed_at = ? WHERE status = 'queued'`)
      .run('La API se está cerrando.', timestamp(), timestamp());
    await Promise.all([...running.keys()].map((id) => new Promise((resolvePromise) => {
      const task = activeTasks.get(id);
      if (task) task.then(resolvePromise, resolvePromise);
      else resolvePromise();
    })));
    await Promise.all([...activeVoiceTasks.values()].map((task) => task.then(() => {}, () => {})));
  }

  return {
    diagnostic,
    getJobs,
    getExports,
    processQueue,
    recoverInterruptedJobs,
    registerUploadRoute,
    registerRoutes,
    saveGeneratedImage,
    shutdown,
  };
}
