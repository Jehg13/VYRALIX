import { z } from 'zod';

export const sceneSchema = z.object({
  order: z.number().int().min(0).max(31),
  durationSeconds: z.number().int().min(1).max(180),
  voiceText: z.string().max(3000),
  subtitleText: z.string().max(1000),
  visualDescription: z.string().max(1000),
  visualType: z.enum(['image', 'video', 'composition']),
  movement: z.string().max(300),
  transition: z.enum(['cut', 'fade']),
  onScreenText: z.string().max(300),
  visualPrompt: z.string().max(1000),
});

export const scenePlanSchema = z.object({
  title: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(80),
  narrativeGoal: z.string().max(500),
  durationSeconds: z.number().int().min(5).max(180),
  sourceScript: z.string().max(5000),
  scenes: z.array(sceneSchema).min(1).max(32),
}).superRefine((plan, context) => {
  const duration = plan.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  if (duration !== plan.durationSeconds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scenes'],
      message: 'La suma de duraciones de las escenas debe coincidir con la duración del proyecto.',
    });
  }
  if (plan.scenes.some((scene, index) => scene.order !== index)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scenes'],
      message: 'El orden de escenas debe ser consecutivo y comenzar en cero.',
    });
  }
});

function splitScript(script, maxScenes) {
  const normalized = script.replace(/\s+/g, ' ').trim();
  if (!normalized) return [''];
  const rawSentences = normalized.match(/[^.!?]+[.!?]?/g)?.map((part) => part.trim()).filter(Boolean) || [normalized];
  const sentences = rawSentences.flatMap((sentence) => {
    if (sentence.length <= 210) return [sentence];
    const words = sentence.split(/\s+/).flatMap((word) => word.length > 210 ? (word.match(/.{1,200}/gu) || [word]) : [word]);
    const chunks = [];
    let chunk = '';
    for (const word of words) {
      if (chunk && `${chunk} ${word}`.length > 210) {
        chunks.push(chunk);
        chunk = '';
      }
      chunk = `${chunk} ${word}`.trim();
    }
    if (chunk) chunks.push(chunk);
    return chunks;
  });
  const groups = [];
  for (const sentence of sentences) {
    const previous = groups.at(-1);
    if (previous && previous.length + sentence.length < 210 && groups.length > 0) {
      groups[groups.length - 1] = `${previous} ${sentence}`;
    } else {
      groups.push(sentence);
    }
  }
  if (groups.length <= maxScenes) return groups;
  const merged = Array.from({ length: maxScenes }, () => '');
  groups.forEach((part, index) => {
    const target = Math.min(maxScenes - 1, Math.floor(index * maxScenes / groups.length));
    merged[target] = `${merged[target]} ${part}`.trim();
  });
  return merged.filter(Boolean);
}

function distributeDuration(total, count, weights) {
  const base = Math.floor(total / count);
  const remainder = total % count;
  const durations = Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
  if (weights.every((weight) => weight === 0)) return durations;
  const weighted = weights.map((weight) => (total * weight) / weights.reduce((sum, item) => sum + item, 0));
  const floors = weighted.map(Math.floor);
  let left = total - floors.reduce((sum, item) => sum + item, 0);
  const fractions = weighted.map((value, index) => ({ index, fraction: value - floors[index] }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let index = 0; index < left; index += 1) floors[fractions[index].index] += 1;
  if (floors.every((duration) => duration >= 1)) return floors;
  return durations;
}

export function createScenePlan({ title, category, script, durationSeconds = 30 }) {
  const duration = z.number().int().min(5).max(180).parse(durationSeconds);
  const parts = splitScript(script, Math.min(8, Math.floor(duration / 3)));
  const count = Math.min(parts.length, Math.floor(duration / 3));
  const selectedParts = parts.slice(0, count);
  const durations = distributeDuration(duration, selectedParts.length, selectedParts.map((part) => Math.max(part.length, 1)));
  const plan = {
    title,
    category,
    narrativeGoal: 'Presentar el guion con claridad y cerrar con su idea principal.',
    durationSeconds: duration,
    sourceScript: script.slice(0, 5000),
    scenes: selectedParts.map((part, index) => ({
      order: index,
      durationSeconds: durations[index],
      voiceText: part,
      subtitleText: part,
      visualDescription: 'Composición local con subtítulo y fondo neutro; agrega un recurso propio para ilustrar esta escena.',
      visualType: 'composition',
      movement: '',
      transition: index === 0 ? 'cut' : 'fade',
      onScreenText: '',
      visualPrompt: '',
    })),
  };
  return scenePlanSchema.parse(plan);
}

export function projectFromRow(row, database) {
  const scenes = database.prepare(`SELECT s.*, a.original_name AS asset_name, a.kind AS asset_kind,
      a.mime_type AS asset_mime_type, a.size_bytes AS asset_size_bytes,
      d.title AS detail_title, d.narrative_goal, d.dialogue, d.shot_type, d.camera_movement,
      d.action_description, d.environment, d.lighting, d.palette, d.continuity_before,
      d.continuity_after, d.audio_notes, d.visual_pending
    FROM media_scenes s LEFT JOIN media_assets a ON a.id = s.asset_id
    LEFT JOIN media_scene_details d ON d.scene_id = s.id
    WHERE s.project_id = ? ORDER BY s.scene_order`).all(row.id);
  const plan = database.prepare('SELECT * FROM media_project_plans WHERE project_id = ?').get(row.id);
  return {
    id: row.id,
    postId: row.post_id,
    title: row.title,
    category: row.category,
    sourceScript: row.source_script,
    durationSeconds: row.duration_seconds,
    voiceAssetId: row.voice_asset_id,
    musicAssetId: row.music_asset_id,
    width: row.width,
    height: row.height,
    fps: row.fps,
    crf: row.crf,
    burnSubtitles: Boolean(row.burn_subtitles),
    status: row.status,
    aiPlan: plan ? {
      narrativeGoal: plan.narrative_goal,
      settings: JSON.parse(plan.settings_json),
      provider: plan.provider,
      model: plan.model,
      createdAt: plan.created_at,
    } : null,
    scenes: scenes.map((scene) => ({
      id: scene.id,
      order: scene.scene_order,
      title: scene.detail_title || '',
      narrativeGoal: scene.narrative_goal || '',
      durationSeconds: scene.duration_seconds,
      voiceText: scene.voice_text,
      dialogue: scene.dialogue || '',
      subtitleText: scene.subtitle_text,
      visualDescription: scene.visual_description,
      shotType: scene.shot_type || '',
      cameraMovement: scene.camera_movement || scene.movement,
      actionDescription: scene.action_description || '',
      environment: scene.environment || '',
      lighting: scene.lighting || '',
      palette: scene.palette || '',
      continuityBefore: scene.continuity_before || '',
      continuityAfter: scene.continuity_after || '',
      visualType: scene.visual_type,
      movement: scene.movement,
      transition: scene.transition,
      onScreenText: scene.on_screen_text,
      audioNotes: scene.audio_notes || '',
      visualPending: scene.asset_id ? false : scene.visual_pending !== 0,
      visualPrompt: scene.visual_prompt,
      asset: scene.asset_id ? {
        id: scene.asset_id,
        name: scene.asset_name,
        kind: scene.asset_kind,
        mimeType: scene.asset_mime_type,
        sizeBytes: scene.asset_size_bytes,
      } : null,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function allocateSubtitleSegments(scenes) {
  let cursor = 0;
  return scenes.flatMap((scene, index) => {
    const text = scene.subtitleText.trim();
    const onScreenText = scene.onScreenText?.trim() || '';
    if (!text && !onScreenText) {
      cursor += scene.durationSeconds;
      return [];
    }
    const start = cursor;
    const end = cursor + scene.durationSeconds;
    cursor = end;
    return [{
      index: index + 1,
      startSeconds: start,
      endSeconds: end,
      text,
      onScreenText,
      timing: 'estimated_by_scene_duration',
    }];
  });
}

function srtTime(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const remainingSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

export function buildSrt(scenes) {
  return allocateSubtitleSegments(scenes)
    .map((segment) => {
      const text = [segment.onScreenText, segment.text].filter(Boolean).join('\n');
      return `${segment.index}\n${srtTime(segment.startSeconds)} --> ${srtTime(segment.endSeconds)}\n${text.replace(/-->/g, '→')}\n`;
    })
    .join('\n');
}
