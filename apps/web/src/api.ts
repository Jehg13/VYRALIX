export type PostStatus = 'idea' | 'draft' | 'pending_review' | 'approved' | 'scheduled' | 'publishing' | 'published' | 'error' | 'archived';
export type Post = {
  id: string;
  title: string;
  platform: string;
  category: string;
  body: string;
  hashtags: string;
  source: string;
  status: PostStatus;
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type PostInput = Omit<Post, 'id' | 'createdAt' | 'updatedAt'>;
export type DashboardData = {
  today: { scheduled: number; published: number };
  posts: Record<PostStatus, number>;
  jobs: Record<string, number>;
  nextPost: Post | null;
  activity: { day: string; count: number }[];
  generatedAt: string;
};
export type Job = {
  id: string;
  postId: string;
  postTitle: string;
  type: 'local_test';
  status: 'pending' | 'processing' | 'completed' | 'error';
  attempts: number;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
export type AiProviderId = 'gemini' | 'groq' | 'ollama';
export type AiProvider = {
  id: AiProviderId;
  name: string;
  model: string | null;
  configured: boolean;
  missing: string[];
  capabilities: string[];
  priority: number;
  mayIncurCost: boolean;
  autoFallbackAllowed: boolean;
  availability: 'unknown' | 'available' | 'unavailable' | 'model_invalid' | 'error';
  checkedAt: string | null;
  availableModels: string[];
  lastError: string | null;
  lastRunAt: string | null;
  isPaid: boolean;
};
export type AiGenerationInput = {
  category: string;
  audience: string;
  tone: string;
  creativeGoal: string;
  format: 'storytime' | 'lista' | 'sketch' | 'explicativo' | 'pregunta' | 'libre';
  durationSeconds: number;
  variants: number;
  restrictions: string;
  provider: 'auto' | AiProviderId;
  variationContext?: string;
};
export type AiVariant = {
  index: number;
  title: string;
  idea: string;
  hook: string;
  script: string;
  description: string;
  hashtags: string[];
  format: string;
  durationSeconds: number;
  imageText: string;
  mediaPrompt: string;
  warnings: string[];
  savedPostId: string | null;
  discarded: boolean;
};
export type AiGeneration = {
  id: string;
  request: AiGenerationInput;
  status: 'pending' | 'completed' | 'failed';
  variants: AiVariant[];
  provider: AiProviderId | null;
  model: string | null;
  attempts: number;
  fallbackReason: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  cost: { kind: 'unknown' | 'measured' | 'estimated'; amount: number | null; currency?: string | null };
  providerAttempts: {
    provider: AiProviderId;
    model: string | null;
    task: string;
    outcome: 'success' | 'failed';
    errorCode: string | null;
    durationMs: number;
    attempt: number;
    fallbackReason: string | null;
    retryAfterSeconds: number | null;
    usage: { inputTokens: number | null; outputTokens: number | null } | null;
    cost: { kind: string; amount: number | null };
    createdAt: string;
  }[];
  error: { code: string; message: string } | null;
  createdAt: string;
  completedAt: string | null;
};
export type MediaAsset = {
  id: string;
  kind: 'image' | 'video' | 'audio';
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  provenance: string;
  license: string;
  missing: boolean;
  createdAt: string;
};
export type MediaScene = {
  id: string;
  order: number;
  title: string;
  narrativeGoal: string;
  durationSeconds: number;
  voiceText: string;
  dialogue: string;
  subtitleText: string;
  visualDescription: string;
  shotType: string;
  cameraMovement: string;
  actionDescription: string;
  environment: string;
  lighting: string;
  palette: string;
  continuityBefore: string;
  continuityAfter: string;
  visualType: 'image' | 'video' | 'composition';
  movement: string;
  transition: 'cut' | 'fade';
  onScreenText: string;
  audioNotes: string;
  visualPending: boolean;
  visualPrompt: string;
  asset: Pick<MediaAsset, 'id' | 'originalName' | 'kind' | 'mimeType' | 'sizeBytes'> | null;
  voiceAudio: MediaVoiceGeneration | null;
  voiceGeneration: MediaVoiceGeneration | null;
};
export type MediaVoiceGeneration = {
  id: string;
  projectId: string;
  sceneId: string;
  provider: 'windows_sapi';
  voiceId: string;
  language: string;
  rate: number;
  volume: number;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  active: boolean;
  stale: boolean;
  durationSeconds: number | null;
  format: string;
  sampleRate: number | null;
  channels: number | null;
  sizeBytes: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  fileUrl: string | null;
};
export type MediaVoiceProvider =
  | {
      id: 'manual_import';
      available: true;
      description: string;
      error: null;
      voices: [];
    }
  | {
      id: 'windows_sapi';
      available: boolean;
      description: string;
      error: string | null;
      voices: { id: string; name: string; language: string; gender: string }[];
    };
export type ScenePlanningSettings = {
  durationSeconds: number;
  sceneCount: number;
  platform: 'TikTok' | 'Reels' | 'Shorts';
  visualStyle: string;
  tone: string;
  editingPace: 'slow' | 'balanced' | 'fast';
  audience: string;
  speechMode: 'narration' | 'dialogue' | 'both';
  language: string;
  provider: 'auto' | AiProviderId;
};
export type PlannedScene = Omit<MediaScene,
  'asset' | 'visualType' | 'visualPending' | 'visualPrompt' | 'movement' | 'voiceAudio' | 'voiceGeneration'
>;
export type MediaProject = {
  id: string;
  postId: string;
  title: string;
  category: string;
  sourceScript: string;
  durationSeconds: number;
  voiceAssetId: string | null;
  musicAssetId: string | null;
  width: number;
  height: number;
  fps: number;
  crf: number;
  burnSubtitles: boolean;
  status: 'draft' | 'ready' | 'rendering' | 'completed' | 'failed';
  aiPlan: {
    narrativeGoal: string;
    settings: ScenePlanningSettings;
    provider: AiProviderId;
    model: string | null;
    createdAt: string;
  } | null;
  scenes: MediaScene[];
  createdAt: string;
  updatedAt: string;
};
export type MediaJob = {
  id: string;
  projectId: string;
  status: 'queued' | 'preparing' | 'processing' | 'validating' | 'completed' | 'failed' | 'cancelled';
  stage: string;
  progress: number | null;
  error: string | null;
  attempt: number;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
};
export type MediaExport = {
  id: string;
  projectId: string;
  projectTitle: string;
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  sizeBytes: number;
  createdAt: string;
  fileUrl: string;
  subtitleUrl: string | null;
};
export type MediaDiagnostics = {
  ffmpeg: {
    ffmpeg: { available: boolean; version: string | null; h264: boolean; aac: boolean; subtitles: boolean; error: string | null };
    ffprobe: { available: boolean; version: string | null; error: string | null };
    windowsSetup: string;
  };
  voiceProviders: MediaVoiceProvider[];
  limits: { maxUploadBytes: number; maxConcurrent: number; maxDurationSeconds: number; defaultWidth: number; defaultHeight: number };
  counts: { assets: number; projects: number; activeJobs: number };
  storage: { mediaDirectory: string; exportsDirectory: string };
};

const baseUrl = import.meta.env.VITE_API_URL || 'http://127.0.0.1:3001/api/v1';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    if (init?.signal?.aborted) throw new DOMException('Solicitud cancelada.', 'AbortError');
    throw new Error('No se pudo conectar con la API local. Comprueba que el servidor esté iniciado.');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `La solicitud falló (HTTP ${response.status}).`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<{ status: string }>('/health'),
  dashboard: () => request<DashboardData>('/dashboard'),
  posts: (search = '', status = '') => {
    const query = new URLSearchParams();
    if (search) query.set('search', search);
    if (status) query.set('status', status);
    return request<Post[]>(`/posts${query.size ? `?${query}` : ''}`);
  },
  createPost: (post: PostInput) => request<Post>('/posts', { method: 'POST', body: JSON.stringify(post) }),
  updatePost: (id: string, post: PostInput) => request<Post>(`/posts/${id}`, { method: 'PUT', body: JSON.stringify(post) }),
  deletePost: (id: string) => request<void>(`/posts/${id}`, { method: 'DELETE' }),
  calendar: (from: Date, to: Date) => {
    const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    return request<Post[]>(`/calendar?${query}`);
  },
  jobs: () => request<Job[]>('/jobs'),
  createJob: (postId: string) => request<Job>('/jobs', { method: 'POST', body: JSON.stringify({ postId }) }),
  createBackup: () => request<{ path: string; createdAt: string }>('/backup', { method: 'POST', body: '{}' }),
  aiProviders: () => request<{ providers: AiProvider[]; priority: AiProviderId[] }>('/ai/providers'),
  checkAiProviders: () => request<{ providers: AiProvider[]; checks: { id: AiProviderId; availability: AiProvider['availability']; errorCode: string | null }[] }>('/ai/providers/check', { method: 'POST', body: '{}' }),
  setAiPriority: (priority: AiProviderId[]) => request<{ priority: AiProviderId[] }>('/ai/providers/priority', { method: 'PUT', body: JSON.stringify({ priority }) }),
  aiGenerations: (limit = 20) => request<AiGeneration[]>(`/ai/generations?limit=${limit}`),
  aiGeneration: (id: string) => request<AiGeneration>(`/ai/generations/${id}`),
  generateAi: (input: AiGenerationInput, idempotencyKey: string) => request<AiGeneration>('/ai/generations', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(input),
  }),
  saveAiVariant: (generationId: string, variantIndex: number, variant: AiVariant) => request<Post>(`/ai/generations/${generationId}/save`, {
    method: 'POST', body: JSON.stringify({ variantIndex, variant }),
  }),
  discardAiVariant: (generationId: string, variantIndex: number) => request<void>(`/ai/generations/${generationId}/discard`, {
    method: 'POST', body: JSON.stringify({ variantIndex }),
  }),
  mediaDiagnostics: () => request<MediaDiagnostics>('/media/diagnostics'),
  mediaProjects: () => request<MediaProject[]>('/media/projects'),
  mediaProject: (id: string) => request<MediaProject>(`/media/projects/${id}`),
  createMediaProject: (postId: string, durationSeconds = 30) => request<{ project: MediaProject; existing: boolean }>('/media/projects', {
    method: 'POST', body: JSON.stringify({ postId, durationSeconds }),
  }),
  planMediaProject: (id: string, settings: ScenePlanningSettings, signal?: AbortSignal) =>
    request<{ plan: { narrativeGoal: string; durationSeconds: number; scenes: PlannedScene[] }; settings: ScenePlanningSettings; provider: AiProviderId; model: string | null; attempts: number; fallbackReason: string | null }>(`/media/projects/${id}/plan`, {
      method: 'POST', body: JSON.stringify({ settings }), signal,
    }),
  regeneratePlannedScene: (id: string, sceneIndex: number, settings: ScenePlanningSettings, plan: { narrativeGoal: string; durationSeconds: number; scenes: PlannedScene[] }, signal?: AbortSignal) =>
    request<{ scene: PlannedScene; provider: AiProviderId; model: string | null; attempts: number; fallbackReason: string | null }>(`/media/projects/${id}/plan/scenes/${sceneIndex}/regenerate`, {
      method: 'POST', body: JSON.stringify({ settings, plan }), signal,
    }),
  applyMediaScenePlan: (id: string, settings: ScenePlanningSettings, plan: { narrativeGoal: string; durationSeconds: number; scenes: PlannedScene[] }, provider: AiProviderId, model: string | null, preserveAssets: boolean) =>
    request<{ project: MediaProject }>(`/media/projects/${id}/plan`, {
      method: 'PUT', body: JSON.stringify({ settings, plan, provider, model, preserveAssets }),
    }),
  updateMediaProject: (id: string, values: Partial<Pick<MediaProject, 'durationSeconds' | 'width' | 'height' | 'fps' | 'crf' | 'burnSubtitles'>> & { voiceAssetId?: string | null; musicAssetId?: string | null }) =>
    request<{ project: MediaProject }>(`/media/projects/${id}`, { method: 'PATCH', body: JSON.stringify(values) }),
  updateMediaScene: (id: string, values: Partial<Omit<MediaScene, 'id' | 'asset' | 'voiceAudio' | 'voiceGeneration'>> & { assetId?: string | null }) =>
    request<{ project: MediaProject }>(`/media/scenes/${id}`, { method: 'PATCH', body: JSON.stringify(values) }),
  startMediaVoiceGeneration: (projectId: string, sceneId: string, settings: { voiceId: string; rate: number; volume: number }) =>
    request<{ generation: MediaVoiceGeneration }>(`/media/projects/${projectId}/scenes/${sceneId}/voice`, {
      method: 'POST', body: JSON.stringify(settings),
    }),
  mediaVoiceGeneration: (id: string) => request<{ generation: MediaVoiceGeneration }>(`/media/voice-generations/${id}`),
  cancelMediaVoiceGeneration: (id: string) => request<{ generation: MediaVoiceGeneration }>(`/media/voice-generations/${id}/cancel`, {
    method: 'POST', body: '{}',
  }),
  unlinkMediaVoice: (id: string) => request<{ project: MediaProject }>(`/media/voice-generations/${id}/unlink`, {
    method: 'POST', body: '{}',
  }),
  mediaAssets: (kind?: MediaAsset['kind']) => request<MediaAsset[]>(`/media/assets${kind ? `?kind=${kind}` : ''}`),
  uploadMediaAsset: (file: File, provenance = 'Importado localmente', license = 'Sin verificar') =>
    request<{ asset: MediaAsset; duplicate: boolean }>('/media/assets', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Media-Filename': encodeURIComponent(file.name),
        'X-Media-Provenance': encodeURIComponent(provenance),
        'X-Media-License': encodeURIComponent(license),
      },
      body: file,
    }),
  deleteMediaAsset: (id: string) => request<void>(`/media/assets/${id}?confirm=true`, { method: 'DELETE' }),
  mediaAssetUrl: (id: string) => `${baseUrl.replace(/\/$/, '')}/media/assets/${id}/content`,
  mediaVoiceUrl: (id: string) => `${baseUrl.replace(/\/$/, '')}/media/voice-generations/${id}/file`,
  mediaFileUrl: (path: string) => `${baseUrl.replace(/\/$/, '')}${path}`,
  mediaJobs: () => request<MediaJob[]>('/media/jobs'),
  startMediaRender: (projectId: string) => request<{ job: MediaJob; existing?: boolean }>(`/media/projects/${projectId}/render`, {
    method: 'POST', body: '{}',
  }),
  cancelMediaJob: (id: string) => request<{ job: MediaJob }>(`/media/jobs/${id}/cancel`, { method: 'POST', body: '{}' }),
  retryMediaJob: (id: string) => request<{ job: MediaJob }>(`/media/jobs/${id}/retry`, { method: 'POST', body: '{}' }),
  mediaExports: () => request<MediaExport[]>('/media/exports'),
};

export function localDateTime(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function toIsoDateTime(value: string) {
  return value ? new Date(value).toISOString() : null;
}

export const statusLabels: Record<PostStatus, string> = {
  idea: 'Idea',
  draft: 'Borrador',
  pending_review: 'Por revisar',
  approved: 'Aprobado',
  scheduled: 'Programado',
  publishing: 'Publicando',
  published: 'Publicado',
  error: 'Error',
  archived: 'Archivado',
};

export function formatDate(value: string | null, options: Intl.DateTimeFormatOptions = {}) {
  if (!value) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', ...options }).format(new Date(value));
}
