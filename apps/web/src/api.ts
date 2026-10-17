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
export type ResearchInput = {
  niche: string;
  audience: string;
  market: string;
  language: string;
  goal: string;
  format: string;
  durationSeconds: number;
  confirmExternalSearch: true;
};
export type ResearchSource = {
  id: string;
  title: string;
  url: string;
  sourceName: string;
  publishedAt: string | null;
  consultedAt: string;
  excerpt: string | null;
  currentness: 'consulted_now';
};
export type ResearchEvidence = {
  statement: string;
  sourceIds: string[];
  evidenceLevel: 'reported' | 'inference' | 'needs_verification';
};
export type ResearchProposal = {
  title: string;
  centralIdea: string;
  targetAudience: string;
  hook: string;
  narrativeDevelopment: string;
  durationSeconds: number;
  description: string;
  hashtags: string[];
  claims: ResearchEvidence[];
  scenes: { order: number; durationSeconds: number; voiceover: string; visualProposal: string; sourceIds: string[] }[];
};
export type ResearchRecord = {
  id: string;
  request: Omit<ResearchInput, 'confirmExternalSearch'>;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  result: {
    summary: string;
    findings: ResearchEvidence[];
    angles: { title: string; hook: string; rationale: string }[];
    sources: ResearchSource[];
    popularity: { status: 'not_measured'; note: string };
  } | null;
  errorCode: string | null;
  provider: 'gemini';
  model: string | null;
  proposal: ResearchProposal | null;
  proposalStatus: 'none' | 'draft' | 'approved' | 'sent_to_media';
  proposalProvider: AiProviderId | null;
  proposalModel: string | null;
  mediaPostId: string | null;
  createdAt: string;
  updatedAt: string;
};
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
export type ImageGenerationCapabilities = {
  provider: 'gemini';
  enabled: boolean;
  model: string | null;
  availableModels: { id: string; name: string }[];
  missing: string[];
  mayIncurCost: boolean;
};
export type ImageGenerationPreview = {
  id: string;
  provider: string;
  model: string;
  contentUrl: string;
};
export type AutomationTaskType = 'research' | 'proposal' | 'image_generation' | 'media_preflight';
export type AutomationTaskStatus = 'queued' | 'running' | 'waiting_for_authorization' | 'waiting_for_external_enabled' | 'waiting_for_quota' | 'succeeded' | 'failed' | 'cancelled';
export type AutomationTask = {
  id: string;
  idempotencyKey: string;
  type: AutomationTaskType;
  status: AutomationTaskStatus;
  stage: string;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  error: string | null;
  provider: string | null;
  model: string | null;
  external: boolean;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  cancelRequested: boolean;
  relatedResourceId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type AutomationProviderState = {
  provider: string;
  model: string | null;
  configured: boolean;
  status: 'unknown' | 'available' | 'not_configured' | 'rate_limited' | 'quota_limited' | 'authentication_error' | 'permission_error' | 'model_unavailable' | 'timeout' | 'unavailable';
  errorCode: string | null;
  retryAt: string | null;
  updatedAt: string;
};
export type MediaScene = {
  id: string;
  order: number;
  title: string;
  narrativeGoal: string;
  durationSeconds: number;
  plannedDurationSeconds: number;
  durationSource: 'estimated' | 'manual';
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
  voiceTiming: {
    plannedDurationSeconds: number;
    currentDurationSeconds: number;
    voiceDurationSeconds: number | null;
    requiredDurationSeconds: number | null;
    targetDurationSeconds: number;
    durationSource: 'estimated' | 'manual';
    autoAdjusted: boolean;
    needsMoreTime: boolean;
  };
  voiceDurationUnavailable: boolean;
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
  voiceTimingSummary: {
    marginSeconds: number;
    requiredDurationSeconds: number;
    projectLimitSeconds: number;
    exceedsProjectLimit: boolean;
    confirmedVoiceScenes: number;
  };
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
  technicalValidationStatus: 'ffprobe_passed';
  visualReviewStatus: 'pending' | 'approved' | 'needs_changes';
  visualReviewedAt: string | null;
  visualReviewNote: string | null;
  createdAt: string;
  fileUrl: string;
  subtitleUrl: string | null;
};
export type MediaDiagnostics = {
  ffmpeg: {
    ffmpeg: {
      available: boolean;
      status: 'unknown' | 'available' | 'not_found' | 'configured_path_not_found' | 'execution_failed' | 'timed_out' | 'capability_check_failed';
      version: string | null;
      h264: boolean;
      aac: boolean;
      subtitles: boolean;
      error: string | null;
    };
    ffprobe: {
      available: boolean;
      status: 'unknown' | 'available' | 'not_found' | 'configured_path_not_found' | 'execution_failed' | 'timed_out';
      version: string | null;
      error: string | null;
    };
    windowsSetup: string;
  };
  voiceProviders: MediaVoiceProvider[];
  limits: { maxUploadBytes: number; maxConcurrent: number; maxDurationSeconds: number; defaultWidth: number; defaultHeight: number; voiceSceneMarginSeconds: number };
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
  researchCapabilities: () => request<{ configured: boolean; provider: 'gemini'; model: string | null; reason: string | null; searchMethod: string; popularityDataAvailable: false }>('/research/capabilities'),
  researches: () => request<ResearchRecord[]>('/research'),
  research: (id: string) => request<ResearchRecord>(`/research/${id}`),
  searchResearch: (input: ResearchInput, requestId: string, signal?: AbortSignal) => request<ResearchRecord>('/research', {
    method: 'POST', headers: { 'Idempotency-Key': requestId }, body: JSON.stringify(input), signal,
  }),
  generateResearchProposal: (id: string, values: { provider: AiProviderId; confirmExternalCost: boolean }, requestId: string, signal?: AbortSignal) =>
    request<ResearchRecord>(`/research/${id}/proposal`, {
      method: 'POST', headers: { 'Idempotency-Key': requestId }, body: JSON.stringify(values), signal,
    }),
  regenerateResearchSection: (
    id: string,
    values: { provider: AiProviderId; confirmExternalCost: boolean; section: 'hook' | 'narrativeDevelopment' | 'hashtags' | 'sceneVoiceover'; sceneOrder?: number },
    requestId: string,
    signal?: AbortSignal,
  ) => request<ResearchRecord>(`/research/${id}/proposal/sections`, {
    method: 'POST', headers: { 'Idempotency-Key': requestId }, body: JSON.stringify(values), signal,
  }),
  saveResearchProposal: (id: string, proposal: ResearchProposal) => request<ResearchRecord>(`/research/${id}/proposal`, {
    method: 'PUT', body: JSON.stringify({ proposal }),
  }),
  approveResearchProposal: (id: string) => request<ResearchRecord>(`/research/${id}/approve`, { method: 'POST', body: '{}' }),
  sendResearchToMedia: (id: string) => request<{ research: ResearchRecord; post: Post; existing: boolean }>(`/research/${id}/send-to-media`, {
    method: 'POST', body: '{}',
  }),
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
  automationTasks: () => request<{ tasks: AutomationTask[] }>('/automation/tasks?limit=100'),
  automationProviders: () => request<{ providers: AutomationProviderState[] }>('/automation/providers'),
  automationSettings: () => request<{ externalOperationsEnabled: boolean; updatedAt: string }>('/automation/settings'),
  setAutomationExternalOperations: (enabled: boolean) => request<{ externalOperationsEnabled: boolean; updatedAt: string }>('/automation/settings', {
    method: 'PUT', body: JSON.stringify({ externalOperationsEnabled: enabled }),
  }),
  enqueueAutomationTask: (input: Record<string, unknown>, idempotencyKey: string) =>
    request<{ task: AutomationTask }>('/automation/tasks', {
      method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(input),
    }),
  authorizeAutomationTask: (id: string) =>
    request<{ task: AutomationTask }>(`/automation/tasks/${id}/authorize`, {
      method: 'POST', body: JSON.stringify({ confirmExternalOperation: true }),
    }),
  cancelAutomationTask: (id: string) =>
    request<{ task: AutomationTask }>(`/automation/tasks/${id}/cancel`, { method: 'POST', body: '{}' }),
  retryAutomationTask: (id: string, confirmExternalOperation: boolean) =>
    request<{ task: AutomationTask }>(`/automation/tasks/${id}/retry`, {
      method: 'POST', body: JSON.stringify({ confirmExternalOperation }),
    }),
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
  mediaImageGenerationCapabilities: () => request<ImageGenerationCapabilities>('/media/image-generations/capabilities'),
  generateMediaImage: (
    values: { provider: 'gemini'; model: string; prompt: string; confirmCost: true },
    requestId: string,
    signal?: AbortSignal,
  ) => request<ImageGenerationPreview>('/media/image-generations', {
    method: 'POST',
    headers: { 'Idempotency-Key': requestId },
    body: JSON.stringify(values),
    signal,
  }),
  saveGeneratedMediaImage: (id: string) =>
    request<{ asset: MediaAsset; duplicate: boolean }>(`/media/image-generations/${id}/save`, { method: 'POST', body: '{}' }),
  generatedMediaImageUrl: (id: string) => `${baseUrl.replace(/\/$/, '')}/media/image-generations/${id}/content`,
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
  reviewMediaExport: (id: string, status: 'approved' | 'needs_changes') =>
    request<{ export: MediaExport }>(`/media/exports/${id}/visual-review`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),
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
  const dateParts = ['weekday', 'era', 'year', 'month', 'day'];
  const timeParts = ['dayPeriod', 'hour', 'minute', 'second', 'fractionalSecondDigits', 'timeZoneName', 'timeStyle'];
  const hasDatePart = dateParts.some((key) => key in options);
  const hasTimePart = timeParts.some((key) => key in options);
  const formatOptions: Intl.DateTimeFormatOptions = !hasDatePart && hasTimePart
    ? { year: 'numeric', month: 'short', day: 'numeric', ...options }
    : hasDatePart || hasTimePart
      ? options
      : { dateStyle: 'medium', ...options };
  return new Intl.DateTimeFormat('es-MX', formatOptions).format(new Date(value));
}
