import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  AlertCircle, AudioLines, Check, Clapperboard, Clock3, Download, Film, ImagePlus, LoaderCircle,
  Mic, Play, RefreshCw, Save, Sparkles, Trash2, Upload, Video, Volume2, X,
} from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { api, formatDate, type AiProvider, type AiProviderId, type MediaAsset, type MediaDiagnostics, type MediaExport, type MediaJob, type MediaProject, type MediaScene, type PlannedScene, type Post, type ScenePlanningSettings } from './api';

type Notice = { kind: 'success' | 'error'; text: string } | null;
type SceneDraft = Pick<MediaScene,
  'title' | 'narrativeGoal' | 'voiceText' | 'dialogue' | 'subtitleText' | 'visualDescription' |
  'durationSeconds' | 'transition' | 'onScreenText' | 'shotType' | 'cameraMovement' |
  'actionDescription' | 'environment' | 'lighting' | 'palette' | 'continuityBefore' |
  'continuityAfter' | 'audioNotes'
>;
type PlanPreview = {
  plan: { narrativeGoal: string; durationSeconds: number; scenes: PlannedScene[] };
  settings: ScenePlanningSettings;
  provider: AiProviderId;
  model: string | null;
  attempts: number;
  fallbackReason: string | null;
};

const activeStatuses: MediaJob['status'][] = ['queued', 'preparing', 'processing', 'validating'];
const defaultPlanSettings: ScenePlanningSettings = {
  durationSeconds: 30,
  sceneCount: 5,
  platform: 'TikTok',
  visualStyle: 'Cinematográfico, con detalles realistas y composición vertical',
  tone: 'Cercano, claro y dinámico',
  editingPace: 'balanced',
  audience: 'Público general adulto',
  speechMode: 'narration',
  language: 'Español',
  provider: 'auto',
};

function fileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MediaStudio({ onNotice }: { onNotice: (notice: Notice) => void }) {
  const location = useLocation();
  const requestedPostId = new URLSearchParams(location.search).get('postId');
  const [diagnostics, setDiagnostics] = useState<MediaDiagnostics | null>(null);
  const [projects, setProjects] = useState<MediaProject[]>([]);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [jobs, setJobs] = useState<MediaJob[]>([]);
  const [exports, setExports] = useState<MediaExport[]>([]);
  const [aiProviders, setAiProviders] = useState<AiProvider[]>([]);
  const [project, setProject] = useState<MediaProject | null>(null);
  const [planSettings, setPlanSettings] = useState<ScenePlanningSettings>(defaultPlanSettings);
  const [selectedVoiceId, setSelectedVoiceId] = useState('');
  const [voiceRate, setVoiceRate] = useState(0);
  const [voiceVolume, setVoiceVolume] = useState(100);
  const [planPreview, setPlanPreview] = useState<PlanPreview | null>(null);
  const [preserveAssets, setPreserveAssets] = useState(false);
  const [postId, setPostId] = useState(requestedPostId || '');
  const [filter, setFilter] = useState<'all' | MediaAsset['kind']>('all');
  const [sceneDrafts, setSceneDrafts] = useState<Record<string, SceneDraft>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [assetQuery, setAssetQuery] = useState('');
  const [provenance, setProvenance] = useState('Importado localmente');
  const [license, setLicense] = useState('Sin verificar');
  const planAbortController = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [diagnosticData, projectData, assetData, postData, jobData, exportData, aiData] = await Promise.all([
        api.mediaDiagnostics(), api.mediaProjects(), api.mediaAssets(), api.posts(), api.mediaJobs(), api.mediaExports(), api.aiProviders(),
      ]);
      setDiagnostics(diagnosticData);
      setProjects(projectData);
      setAssets(assetData);
      setPosts(postData);
      setJobs(jobData);
      setExports(exportData);
      setAiProviders(aiData.providers);
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  const voiceProvider = diagnostics?.voiceProviders.find((provider) => provider.id === 'windows_sapi');
  const pendingVoiceGenerations = project?.scenes.some((scene) => ['queued', 'processing'].includes(scene.voiceGeneration?.status || '')) || false;

  useEffect(() => {
    const configured = aiProviders.filter((provider) => provider.configured);
    if (configured.length && planSettings.provider === 'auto') {
      const local = configured.find((provider) => provider.id === 'ollama');
      setPlanSettings((current) => current.provider === 'auto'
        ? { ...current, provider: local?.id || configured[0].id }
        : current);
    }
  }, [aiProviders, planSettings.provider]);

  useEffect(() => {
    const voices = diagnostics?.voiceProviders.find((provider) => provider.id === 'windows_sapi')?.voices || [];
    if (voices.length && !voices.some((voice) => voice.id === selectedVoiceId)) {
      setSelectedVoiceId(voices.find((voice) => voice.language.toLowerCase().startsWith('es'))?.id || voices[0].id);
    }
  }, [diagnostics, selectedVoiceId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const running = jobs.some((job) => activeStatuses.includes(job.status));
    if (!running) return;
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => window.clearInterval(timer);
  }, [jobs, refresh]);
  useEffect(() => {
    if (!project || !pendingVoiceGenerations) return;
    const timer = window.setInterval(() => {
      void api.mediaProject(project.id).then(setProject).catch((reason) => setError((reason as Error).message));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [project?.id, pendingVoiceGenerations]);

  const candidates = useMemo(
    () => posts.filter((post) => ['draft', 'pending_review', 'approved'].includes(post.status)),
    [posts],
  );
  const visibleAssets = useMemo(() => assets
    .filter((asset) => filter === 'all' || asset.kind === filter)
    .filter((asset) => asset.originalName.toLowerCase().includes(assetQuery.trim().toLowerCase())), [assets, filter, assetQuery]);
  const activeJobs = jobs.filter((job) => activeStatuses.includes(job.status));
  const failedJobs = jobs.filter((job) => job.status === 'failed');
  const selectedProjectJobs = project ? jobs.filter((job) => job.projectId === project.id) : jobs;
  const selectedAiProvider = aiProviders.find((provider) => provider.id === planSettings.provider);
  const configuredAiProviders = aiProviders.filter((provider) => provider.configured);
  const previewDuration = planPreview?.plan.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0) || 0;
  const pendingAiVisuals = project?.aiPlan ? project.scenes.filter((scene) => scene.visualPending).length : 0;
  const narratableScenes = project?.scenes.filter((scene) => scene.voiceText.trim()) || [];
  const unsavedVoiceScenes = project?.scenes.filter((scene) => draftFor(scene).voiceText !== scene.voiceText).length || 0;
  const selectedVoice = voiceProvider?.voices.find((voice) => voice.id === selectedVoiceId) || null;

  async function openProject(id: string) {
    setBusy('project');
    try {
      const found = await api.mediaProjects();
      setProjects(found);
      setProject(found.find((item) => item.id === id) || null);
      setSceneDrafts({});
      setPlanPreview(null);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function reviewExport(item: MediaExport, status: 'approved' | 'needs_changes') {
    setBusy(`review-${item.id}`);
    setError('');
    try {
      const result = await api.reviewMediaExport(item.id, status);
      setExports((current) => current.map((entry) => entry.id === item.id ? result.export : entry));
      onNotice({
        kind: 'success',
        text: status === 'approved'
          ? 'La revisión visual quedó registrada para esta exportación.'
          : 'La exportación quedó marcada para correcciones visuales.',
      });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function createProject() {
    if (!postId) return;
    setBusy('create');
    setError('');
    try {
      const result = await api.createMediaProject(postId, 30);
      setProject(result.project);
      setSceneDrafts({});
      setPlanPreview(null);
      onNotice({ kind: 'success', text: result.existing ? 'Proyecto existente abierto.' : 'Proyecto creado a partir del borrador; el borrador original no se modificó.' });
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function importFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    setBusy('upload');
    setError('');
    let imported = 0;
    try {
      for (const file of files) {
        const result = await api.uploadMediaAsset(file, provenance, license);
        if (!result.duplicate) imported += 1;
      }
      onNotice({ kind: 'success', text: `${imported} recurso(s) nuevo(s) importado(s); las copias idénticas se detectan por SHA-256.` });
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  function draftFor(scene: MediaScene): SceneDraft {
    return sceneDrafts[scene.id] || {
      title: scene.title,
      narrativeGoal: scene.narrativeGoal,
      voiceText: scene.voiceText,
      dialogue: scene.dialogue,
      subtitleText: scene.subtitleText,
      visualDescription: scene.visualDescription,
      durationSeconds: scene.durationSeconds,
      transition: scene.transition,
      onScreenText: scene.onScreenText,
      shotType: scene.shotType,
      cameraMovement: scene.cameraMovement,
      actionDescription: scene.actionDescription,
      environment: scene.environment,
      lighting: scene.lighting,
      palette: scene.palette,
      continuityBefore: scene.continuityBefore,
      continuityAfter: scene.continuityAfter,
      audioNotes: scene.audioNotes,
    };
  }

  function editScene(scene: MediaScene, field: keyof SceneDraft, value: string | number) {
    setSceneDrafts((current) => ({ ...current, [scene.id]: { ...draftFor(scene), [field]: value } }));
  }

  async function saveScene(scene: MediaScene) {
    setBusy(`scene-${scene.id}`);
    setError('');
    try {
      const result = await api.updateMediaScene(scene.id, draftFor(scene));
      setProject(result.project);
      setSceneDrafts((current) => { const next = { ...current }; delete next[scene.id]; return next; });
      await refresh();
      onNotice({ kind: 'success', text: 'Escena guardada.' });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function performVoiceGeneration(scene: MediaScene, confirmReplacement = true): Promise<boolean> {
    if (!project) return false;
    if (!voiceProvider?.available || !selectedVoice) {
      setError(voiceProvider?.error || 'No hay voces locales instaladas disponibles.');
      return false;
    }
    if (draftFor(scene).voiceText !== scene.voiceText) {
      setError(`Guarda primero la narración de la escena ${scene.order + 1}; la generación usa únicamente texto guardado.`);
      return false;
    }
    if (scene.voiceAudio?.active && confirmReplacement &&
      !window.confirm(`La escena ${scene.order + 1} ya tiene una voz guardada. Solo se activará la nueva si se genera y valida correctamente. ¿Continuar?`)) return false;
    setBusy(`voice-${scene.id}`);
    setError('');
    try {
      const result = await api.startMediaVoiceGeneration(project.id, scene.id, {
        voiceId: selectedVoice.id,
        rate: voiceRate,
        volume: voiceVolume,
      });
      let generation = result.generation;
      while (generation.status === 'queued' || generation.status === 'processing') {
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        generation = (await api.mediaVoiceGeneration(generation.id)).generation;
      }
      const updated = await api.mediaProject(project.id);
      setProject(updated);
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
      if (generation.status !== 'completed') throw new Error(generation.error || 'La voz no se pudo generar.');
      onNotice({ kind: 'success', text: `Narración generada localmente · ${generation.durationSeconds?.toFixed(1)} s · ${generation.voiceId}.` });
      return true;
    } catch (reason) {
      setError((reason as Error).message);
      try {
        setProject(await api.mediaProject(project.id));
      } catch (refreshError) {
        setError(`${(reason as Error).message} No se pudo actualizar el estado del proyecto: ${(refreshError as Error).message}`);
      }
      return false;
    } finally {
      setBusy('');
    }
  }

  async function generateAllVoices() {
    if (!project) return;
    const scenes = narratableScenes.filter((scene) => draftFor(scene).voiceText === scene.voiceText);
    if (!scenes.length) {
      setError('No hay narraciones guardadas para generar. Guarda primero los cambios de texto.');
      return;
    }
    const skipped = narratableScenes.length - scenes.length;
    const message = `Se generará voz local para ${scenes.length} escena(s) con narración${skipped ? `; ${skipped} escena(s) con cambios sin guardar se omitirán` : ''}. Las voces anteriores se conservan si una generación falla. ¿Continuar?`;
    if (!window.confirm(message)) return;
    for (const scene of scenes) {
      const generated = await performVoiceGeneration(scene, false);
      if (!generated) break;
    }
  }

  async function unlinkVoice(scene: MediaScene) {
    if (!scene.voiceAudio?.active || !window.confirm(`¿Desvincular la voz de la escena ${scene.order + 1}? El archivo validado se conserva en el historial local.`)) return;
    setBusy(`unlink-voice-${scene.id}`);
    setError('');
    try {
      const result = await api.unlinkMediaVoice(scene.voiceAudio.id);
      setProject(result.project);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function assignAsset(scene: MediaScene, assetId: string) {
    const selected = assets.find((asset) => asset.id === assetId);
    const nextAssetId = assetId || null;
    if (scene.asset?.id !== nextAssetId && scene.asset &&
      !window.confirm(selected
        ? `La escena ${scene.order + 1} ya tiene asignado “${scene.asset.originalName}”. ¿Quieres reemplazarlo por “${selected.originalName}”?`
        : `La escena ${scene.order + 1} ya tiene asignado “${scene.asset.originalName}”. ¿Quieres quitarlo y usar el fondo de composición?`)) return;
    setBusy(`asset-${scene.id}`);
    setError('');
    try {
      const result = await api.updateMediaScene(scene.id, {
        assetId: nextAssetId,
        visualType: selected && selected.kind !== 'audio' ? selected.kind : 'composition',
      });
      setProject(result.project);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function updateSettings(values: Parameters<typeof api.updateMediaProject>[1]) {
    if (!project) return;
    setBusy('settings');
    setError('');
    try {
      const result = await api.updateMediaProject(project.id, values);
      setProject(result.project);
      setSceneDrafts({});
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function startRender() {
    if (!project) return;
    setBusy('render');
    setError('');
    try {
      const result = await api.startMediaRender(project.id);
      await refresh();
      onNotice({ kind: 'success', text: result.existing ? 'Ya hay un renderizado activo para este proyecto.' : 'Trabajo real de FFmpeg agregado a la cola.' });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function planWithAi() {
    if (!project) return;
    setBusy('plan');
    setError('');
    const controller = new AbortController();
    planAbortController.current = controller;
    try {
      const result = await api.planMediaProject(project.id, planSettings, controller.signal);
      setPlanPreview(result);
      setPreserveAssets(false);
      onNotice({ kind: 'success', text: `Propuesta generada con ${result.provider}${result.model ? ` · ${result.model}` : ''}. Nada se guardará hasta que la apruebes.` });
    } catch (reason) {
      if ((reason as Error).name !== 'AbortError') setError((reason as Error).message);
    } finally {
      if (planAbortController.current === controller) planAbortController.current = null;
      setBusy('');
    }
  }

  function cancelPlanRequest() {
    planAbortController.current?.abort();
  }

  function editPlannedScene<K extends keyof PlannedScene>(index: number, field: K, value: PlannedScene[K]) {
    setPlanPreview((current) => current ? ({
      ...current,
      plan: {
        ...current.plan,
        scenes: current.plan.scenes.map((scene, sceneIndex) => sceneIndex === index ? { ...scene, [field]: value } : scene),
      },
    }) : current);
  }

  async function regenerateScene(index: number) {
    if (!project || !planPreview) return;
    setBusy(`regen-${index}`);
    setError('');
    const controller = new AbortController();
    planAbortController.current = controller;
    try {
      const result = await api.regeneratePlannedScene(project.id, index, planPreview.settings, planPreview.plan, controller.signal);
      setPlanPreview((current) => current ? ({
        ...current,
        plan: { ...current.plan, scenes: current.plan.scenes.map((scene, sceneIndex) => sceneIndex === index ? result.scene : scene) },
      }) : current);
      onNotice({ kind: 'success', text: `Escena ${index + 1} regenerada; las escenas vecinas y su duración se conservaron.` });
    } catch (reason) {
      if ((reason as Error).name !== 'AbortError') setError((reason as Error).message);
    } finally {
      if (planAbortController.current === controller) planAbortController.current = null;
      setBusy('');
    }
  }

  async function acceptPlan() {
    if (!project || !planPreview) return;
    const previousAssignments = project.scenes.filter((scene) => scene.asset).length;
    const detail = previousAssignments && !preserveAssets
      ? `${previousAssignments} recurso(s) asignado(s) se desasignarán, pero seguirán en la biblioteca. `
      : previousAssignments
        ? `${previousAssignments} recurso(s) asignado(s) se conservarán según la posición de escena; revísalos antes de renderizar. `
        : '';
    const unsaved = Object.keys(sceneDrafts).length ? 'También se descartarán los cambios de escena que aún no guardaste. ' : '';
    const message = `${detail}${unsaved}Se reemplazarán las ${project.scenes.length} escenas actuales del proyecto por la propuesta revisada. ¿Guardar el plan?`;
    if (!window.confirm(message)) return;
    setBusy('apply-plan');
    setError('');
    try {
      const result = await api.applyMediaScenePlan(
        project.id, planPreview.settings, planPreview.plan, planPreview.provider, planPreview.model, preserveAssets,
      );
      setProject(result.project);
      setSceneDrafts({});
      setPlanPreview(null);
      await refresh();
      onNotice({ kind: 'success', text: 'Plan IA aprobado y guardado. Las escenas sin recursos visuales aparecen como material pendiente.' });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function cancelJob(job: MediaJob) {
    setBusy(`cancel-${job.id}`);
    try {
      await api.cancelMediaJob(job.id);
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function retryJob(job: MediaJob) {
    setBusy(`retry-${job.id}`);
    try {
      await api.retryMediaJob(job.id);
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function deleteAsset(asset: MediaAsset) {
    if (!window.confirm(`¿Eliminar “${asset.originalName}” de la biblioteca local? Los recursos asignados no se pueden eliminar.`)) return;
    try {
      await api.deleteMediaAsset(asset.id);
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  if (loading && !diagnostics) return <div className="loading-state"><LoaderCircle size={20} className="spin" />Cargando Media Studio…</div>;

  const diagnosticInfo = diagnostics?.ffmpeg;
  return <div className="media-studio">
    <header className="page-heading media-page-heading">
      <div><div className="eyebrow">PRODUCCIÓN AUDIOVISUAL LOCAL</div><h1>Media Studio</h1><p>Convierte guiones en proyectos editables y exporta con FFmpeg en tu equipo.</p></div>
      <div className="heading-actions">
        <label className="button secondary media-upload-button"><Upload size={15} />{busy === 'upload' ? 'Importando…' : 'Importar recursos'}<input type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/mp4,audio/ogg" multiple disabled={busy === 'upload'} onChange={(event) => void importFiles(event)} /></label>
        <button className="button secondary" onClick={() => void refresh()} disabled={busy !== ''}><RefreshCw size={15} /> Actualizar</button>
      </div>
    </header>
    {error && <div className="error-banner"><AlertCircle size={16} /><span>{error}</span><button onClick={() => setError('')}>Cerrar</button></div>}
    <div className="media-metrics">
      <article className="panel media-metric"><span>PROYECTOS</span><strong>{diagnostics?.counts.projects ?? 0}</strong><small>Persistidos en SQLite</small></article>
      <article className="panel media-metric"><span>RECURSOS LOCALES</span><strong>{diagnostics?.counts.assets ?? 0}</strong><small>Archivos importados</small></article>
      <article className="panel media-metric"><span>TRABAJOS ACTIVOS</span><strong>{activeJobs.length}</strong><small>{failedJobs.length} fallidos en historial</small></article>
      <article className="panel media-metric capability-metric"><span>FFMPEG / FFPROBE</span><strong className={diagnosticInfo?.ffmpeg.available && diagnosticInfo.ffmpeg.status === 'available' && diagnosticInfo.ffprobe.available ? 'capability-on' : 'capability-off'}>{diagnosticInfo?.ffmpeg.available && diagnosticInfo.ffmpeg.status === 'available' && diagnosticInfo.ffprobe.available ? 'Listo' : 'Revisar diagnóstico'}</strong><small>{diagnosticInfo?.ffmpeg.error || diagnosticInfo?.ffprobe.error || diagnosticInfo?.ffmpeg.version}</small></article>
    </div>

    {diagnosticInfo && (!diagnosticInfo.ffmpeg.available || diagnosticInfo.ffmpeg.status !== 'available' || !diagnosticInfo.ffprobe.available) && <section className="media-diagnostic-banner">
      <AlertCircle size={18} /><div><strong>La app sigue funcionando; los renderizados requieren FFmpeg y FFprobe.</strong>
        <p>{diagnosticInfo.ffmpeg.error || diagnosticInfo.ffprobe.error} En Windows puedes instalar una distribución mantenida y confiable de FFmpeg o definir <code>FFMPEG_PATH</code> y <code>FFPROBE_PATH</code> en el archivo .env. No se descarga ni instala desde VYRALIX.</p>
        <p>El plan usa 720 × 1280, 30 FPS y codificación por CPU. Las escenas sin imagen o clip usan un fondo abstracto local; no se generan imágenes ni videos realistas.</p>
      </div>
    </section>}

    <div className="media-workbench">
      <section className="panel media-project-panel">
        <div className="panel-heading"><div><div className="eyebrow">PROYECTOS</div><h2>Producción</h2><p>Empieza con un guion existente; su estado y texto no se alteran.</p></div><Clapperboard size={18} className="muted-icon" /></div>
        <div className="media-create-row">
          <select aria-label="Seleccionar contenido de origen" value={postId} onChange={(event) => setPostId(event.target.value)}>
            <option value="">Elegir borrador para crear video…</option>
            {candidates.map((post) => <option key={post.id} value={post.id}>{post.title} · {post.status}</option>)}
          </select>
          <button className="button primary" disabled={!postId || busy !== ''} onClick={() => void createProject()}>{busy === 'create' ? <LoaderCircle size={14} className="spin" /> : <Film size={14} />} Crear proyecto</button>
        </div>
        {projects.length ? <div className="media-project-list">{projects.map((item) => <button key={item.id} className={`media-project-row${project?.id === item.id ? ' selected' : ''}`} onClick={() => void openProject(item.id)}>
          <span className="media-project-icon"><Film size={16} /></span><span className="media-project-copy"><strong>{item.title}</strong><small>{item.scenes.length} escenas · {item.durationSeconds}s · {item.width}×{item.height}</small></span><span className={`media-project-state ${item.status}`}>{item.status}</span>
        </button>)}</div> : <div className="media-empty"><Film size={20} /><strong>Aún no hay proyectos</strong><span>Selecciona un borrador para crear un plan local de escenas.</span></div>}
      </section>

      <section className="panel media-assets-panel">
        <div className="panel-heading"><div><div className="eyebrow">BIBLIOTECA LOCAL</div><h2>Recursos</h2><p>Previsualiza imágenes y clips importados desde este equipo.</p></div><ImagePlus size={17} className="muted-icon" /></div>
        <div className="media-assets-toolbar"><input aria-label="Buscar recursos" placeholder="Buscar archivo…" value={assetQuery} onChange={(event) => setAssetQuery(event.target.value)} /><select aria-label="Filtrar recursos" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">Todos</option><option value="image">Imágenes</option><option value="video">Videos</option><option value="audio">Audio</option></select></div>
        <div className="media-provenance-fields"><label>Procedencia declarada<input maxLength={300} value={provenance} onChange={(event) => setProvenance(event.target.value)} /></label><label>Licencia / atribución<input maxLength={300} value={license} onChange={(event) => setLicense(event.target.value)} /></label></div>
        {visibleAssets.length ? <div className="media-asset-grid">{visibleAssets.map((asset) => <article className="media-asset-card" key={asset.id}>
          <div className="media-asset-preview">
            {asset.missing ? <AlertCircle size={20} /> : asset.kind === 'image'
              ? <img src={api.mediaAssetUrl(asset.id)} alt={asset.originalName} loading="lazy" />
              : asset.kind === 'video'
                ? <video src={api.mediaAssetUrl(asset.id)} muted preload="metadata" />
                : <audio controls preload="none" src={api.mediaAssetUrl(asset.id)} aria-label={`Previsualizar ${asset.originalName}`} />}
            <span>{asset.kind === 'image' ? 'IMG' : asset.kind === 'video' ? 'VIDEO' : 'AUDIO'}</span>
          </div>
          <div className="media-asset-info"><strong title={asset.originalName}>{asset.originalName}</strong><small>{fileSize(asset.sizeBytes)} · {asset.mimeType}{asset.width ? ` · ${asset.width}×${asset.height}` : ''}{asset.durationSeconds ? ` · ${asset.durationSeconds.toFixed(1)}s` : ''}</small><small>{asset.license} · {asset.provenance}</small></div>
          <button className="icon-button media-delete-asset" title="Eliminar recurso" aria-label={`Eliminar ${asset.originalName}`} onClick={() => void deleteAsset(asset)}><Trash2 size={14} /></button>
        </article>)}</div> : <div className="media-empty compact"><Upload size={18} /><strong>Biblioteca vacía</strong><span>Importa imágenes, clips y grabaciones; no se descargan recursos de internet.</span></div>}
        <p className="media-license-note">Usa material propio o con licencia adecuada. VYRALIX conserva la procedencia declarada; no verifica derechos de uso.</p>
      </section>
    </div>

    {project && <section className="panel media-editor-panel">
      <div className="panel-heading"><div><div className="eyebrow">PLANIFICACIÓN Y EDICIÓN AUDIOVISUAL</div><h2>{project.title}</h2><p>Prepara una propuesta con IA y revísala antes de sustituir las escenas del proyecto.</p></div><span className={`media-project-state ${project.status}`}>{project.status}</span></div>
      {project.aiPlan && <div className="media-ai-plan-meta"><Sparkles size={15} /><span>Plan aprobado con {project.aiPlan.provider}{project.aiPlan.model ? ` · ${project.aiPlan.model}` : ''} · {project.aiPlan.settings.platform} · {project.aiPlan.settings.language} · {project.aiPlan.createdAt ? formatDate(project.aiPlan.createdAt) : ''}</span></div>}

      <section className="media-plan-controls" aria-labelledby="media-plan-heading">
        <div className="media-plan-controls-heading"><div><div className="eyebrow">PLANIFICACIÓN INTELIGENTE</div><h3 id="media-plan-heading">Planificar con IA</h3><p>La IA prepara una propuesta; el proyecto no cambia hasta que la revises y confirmes.</p></div><Sparkles size={19} /></div>
        <div className="media-plan-settings">
          <label>Duración objetivo (s)<input type="number" min={5} max={180} value={planSettings.durationSeconds} disabled={Boolean(planPreview) || busy !== ''} onChange={(event) => setPlanSettings((current) => ({ ...current, durationSeconds: Number(event.target.value) }))} /></label>
          <label>Número de escenas<select value={planSettings.sceneCount} disabled={Boolean(planPreview) || busy !== ''} onChange={(event) => setPlanSettings((current) => ({ ...current, sceneCount: Number(event.target.value) }))}>{Array.from({ length: 12 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count} escena(s)</option>)}</select></label>
          <label>Plataforma<select value={planSettings.platform} disabled={Boolean(planPreview) || busy !== ''} onChange={(event) => setPlanSettings((current) => ({ ...current, platform: event.target.value as ScenePlanningSettings['platform'] }))}><option>TikTok</option><option>Reels</option><option>Shorts</option></select></label>
          <label>Proveedor IA<select value={planSettings.provider} disabled={Boolean(planPreview) || busy !== ''} onChange={(event) => setPlanSettings((current) => ({ ...current, provider: event.target.value as ScenePlanningSettings['provider'] }))}><option value="auto">Automático según prioridad</option>{configuredAiProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{provider.mayIncurCost ? ' · puede generar cargos' : ' · local'}</option>)}</select></label>
          <label>Estilo visual<input maxLength={120} value={planSettings.visualStyle} disabled={Boolean(planPreview) || busy !== ''} onChange={(event) => setPlanSettings((current) => ({ ...current, visualStyle: event.target.value }))} /></label>
          <label>Tono narrativo<input maxLength={120} value={planSettings.tone} disabled={Boolean(planPreview) || busy !== ''} onChange={(event) => setPlanSettings((current) => ({ ...current, tone: event.target.value }))} /></label>
          <label>Velocidad de edición<select value={planSettings.editingPace} disabled={Boolean(planPreview) || busy !== ''} onChange={(event) => setPlanSettings((current) => ({ ...current, editingPace: event.target.value as ScenePlanningSettings['editingPace'] }))}><option value="slow">Pausada</option><option value="balanced">Equilibrada</option><option value="fast">Rápida</option></select></label>
          <label>Público<input maxLength={240} value={planSettings.audience} disabled={Boolean(planPreview) || busy !== ''} onChange={(event) => setPlanSettings((current) => ({ ...current, audience: event.target.value }))} /></label>
          <label>Contenido hablado<select value={planSettings.speechMode} disabled={Boolean(planPreview) || busy !== ''} onChange={(event) => setPlanSettings((current) => ({ ...current, speechMode: event.target.value as ScenePlanningSettings['speechMode'] }))}><option value="narration">Narración</option><option value="dialogue">Diálogos</option><option value="both">Narración y diálogos</option></select></label>
          <label>Idioma<input maxLength={80} value={planSettings.language} disabled={Boolean(planPreview) || busy !== ''} onChange={(event) => setPlanSettings((current) => ({ ...current, language: event.target.value }))} /></label>
        </div>
        {selectedAiProvider?.mayIncurCost
          ? <p className="media-plan-cost-note">Este proveedor alojado puede generar cargos según tu cuenta y sus tarifas. No se llama hasta que solicites la planificación.</p>
          : planSettings.provider === 'auto'
            ? <p className="media-plan-cost-note">El modo automático usa la prioridad configurada; Gemini o Groq podrían generar cargos. El fallback se limita a proveedores permitidos en Configuración.</p>
            : <p className="media-plan-local-note">La solicitud se envía al backend y no expone credenciales al navegador.</p>}
        {!configuredAiProviders.length && <p className="media-plan-cost-note">No hay proveedores configurados. Añade un modelo local Ollama o configura un proveedor en <Link to="/configuracion">Configuración</Link>; no se activará ninguno automáticamente.</p>}
        {planPreview && (busy === 'plan' || busy.startsWith('regen-'))
          ? <div className="media-plan-actions"><span role="status"><LoaderCircle size={14} className="spin" />Actualizando propuesta; el proyecto no cambia…</span><button className="button secondary" onClick={cancelPlanRequest}>Cancelar solicitud</button></div>
          : planPreview
          ? <div className="media-plan-actions"><button className="button secondary" disabled={busy !== ''} onClick={() => setPlanPreview(null)}><X size={14} />Descartar propuesta</button></div>
          : busy === 'plan'
            ? <div className="media-plan-actions"><span role="status"><LoaderCircle size={14} className="spin" />Consultando proveedor; el plan aún no se guarda…</span><button className="button secondary" onClick={cancelPlanRequest}>Cancelar solicitud</button></div>
            : <div className="media-plan-actions"><button className="button primary" disabled={busy !== '' || !configuredAiProviders.length || planSettings.sceneCount > planSettings.durationSeconds} onClick={() => void planWithAi()}><Sparkles size={14} />Planificar con IA</button></div>}
      </section>

      {planPreview && <section className="media-plan-preview" aria-label="Propuesta de plan audiovisual editable">
        <div className="media-plan-preview-heading"><div><div className="eyebrow">PROPUESTA SIN GUARDAR</div><h3>Revisa y edita antes de aprobar</h3><p>{planPreview.provider}{planPreview.model ? ` · ${planPreview.model}` : ''} · {planPreview.attempts} intento(s){planPreview.fallbackReason ? ` · fallback: ${planPreview.fallbackReason}` : ''}</p><p>{planPreview.plan.narrativeGoal}</p></div><div className={previewDuration === planPreview.plan.durationSeconds ? 'media-plan-duration-valid' : 'media-plan-duration-invalid'}>{previewDuration} / {planPreview.plan.durationSeconds} s</div></div>
        <div className="media-plan-preview-list">{planPreview.plan.scenes.map((scene, index) => <article className="media-plan-scene" key={scene.id}>
          <div className="media-plan-scene-heading"><strong>ESCENA {index + 1} · MATERIAL VISUAL PENDIENTE</strong><label>Duración (s)<input type="number" min={1} max={180} value={scene.durationSeconds} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'durationSeconds', Number(event.target.value))} /></label></div>
          <div className="media-plan-fields">
            <label>Título<input maxLength={120} value={scene.title} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'title', event.target.value)} /></label>
            <label>Objetivo narrativo<input maxLength={300} value={scene.narrativeGoal} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'narrativeGoal', event.target.value)} /></label>
            <label className="wide">Descripción visual<textarea rows={3} maxLength={1000} value={scene.visualDescription} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'visualDescription', event.target.value)} /></label>
            <label>Tipo de plano<input maxLength={120} value={scene.shotType} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'shotType', event.target.value)} /></label>
            <label>Movimiento de cámara<input maxLength={240} value={scene.cameraMovement} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'cameraMovement', event.target.value)} /></label>
            <label className="wide">Acción y cierre de escena<textarea rows={2} maxLength={500} value={scene.actionDescription} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'actionDescription', event.target.value)} /></label>
            <label>Entorno<input maxLength={300} value={scene.environment} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'environment', event.target.value)} /></label>
            <label>Iluminación<input maxLength={240} value={scene.lighting} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'lighting', event.target.value)} /></label>
            <label>Paleta<input maxLength={120} value={scene.palette} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'palette', event.target.value)} /></label>
            <label>Continuidad desde la anterior<input maxLength={300} value={scene.continuityBefore} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'continuityBefore', event.target.value)} /></label>
            <label>Continuidad hacia la siguiente<input maxLength={300} value={scene.continuityAfter} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'continuityAfter', event.target.value)} /></label>
            <label className="wide">Narración<textarea rows={3} maxLength={3000} value={scene.voiceText} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'voiceText', event.target.value)} /></label>
            <label className="wide">Diálogo<textarea rows={2} maxLength={3000} value={scene.dialogue} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'dialogue', event.target.value)} /></label>
            <label>Subtítulo estimado<textarea rows={2} maxLength={1000} value={scene.subtitleText} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'subtitleText', event.target.value)} /></label>
            <label>Título / texto en pantalla (zona superior)<input maxLength={300} value={scene.onScreenText} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'onScreenText', event.target.value)} /></label>
            <label>Transición<select value={scene.transition} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'transition', event.target.value as PlannedScene['transition'])}><option value="cut">Corte directo</option><option value="fade">Fundido</option></select></label>
            <label>Audio y ambiente<input maxLength={300} value={scene.audioNotes} disabled={busy !== ''} onChange={(event) => editPlannedScene(index, 'audioNotes', event.target.value)} /></label>
          </div>
          <button className="button secondary small-button" disabled={busy !== ''} onClick={() => void regenerateScene(index)}>{busy === `regen-${index}` ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}Regenerar solo esta escena</button>
        </article>)}</div>
        <p className="media-plan-estimate-note">Los tiempos son estimaciones por escena; los subtítulos no están alineados palabra por palabra. Cada escena requiere que asignes recursos de tu biblioteca o aceptes el fondo de composición local.</p>
        {project.scenes.some((scene) => scene.asset) && <label className="media-plan-preserve-assets"><input type="checkbox" checked={preserveAssets} disabled={busy !== ''} onChange={(event) => setPreserveAssets(event.target.checked)} />Conservar recursos actuales según la posición de escena; revisar las asignaciones antes de renderizar.</label>}
        <div className="media-plan-actions"><button className="button secondary" disabled={busy !== ''} onClick={() => setPlanPreview(null)}><X size={14} />Cancelar sin cambiar el proyecto</button><button className="button secondary" disabled={busy !== ''} onClick={() => void planWithAi()}><RefreshCw size={14} />Regenerar plan completo</button><button className="button primary" disabled={busy !== '' || previewDuration !== planPreview.plan.durationSeconds} onClick={() => void acceptPlan()}><Check size={14} />Aprobar y guardar plan</button></div>
      </section>}

      <section className="media-voice-panel" aria-labelledby="media-voice-heading">
        <div className="media-voice-heading">
          <div><div className="eyebrow">SÍNTESIS LOCAL</div><h3 id="media-voice-heading"><Mic size={16} />Voz y narración</h3>
            <p>Windows SAPI crea archivos WAV reales en este equipo. El texto no se envía a Gemini, Groq ni a internet.</p></div>
          {narratableScenes.length > 0 && <button className="button secondary small-button" disabled={busy !== '' || !voiceProvider?.available || pendingVoiceGenerations || unsavedVoiceScenes === narratableScenes.length} onClick={() => void generateAllVoices()}><AudioLines size={14} />Generar todas las narraciones</button>}
        </div>
        <div className="media-voice-settings">
          <label>Motor<select value={voiceProvider?.id || 'windows_sapi'} disabled><option value="windows_sapi">Windows SAPI · local</option></select></label>
          <label>Voz e idioma<select aria-label="Voz e idioma" value={selectedVoiceId} disabled={!voiceProvider?.available || busy !== ''} onChange={(event) => setSelectedVoiceId(event.target.value)}>{voiceProvider?.voices.map((voice) => <option key={`${voice.id}-${voice.language}`} value={voice.id}>{voice.name} · {voice.language}</option>)}</select></label>
          <label>Velocidad <span>{voiceRate}</span><input type="range" min={-5} max={5} step={1} value={voiceRate} disabled={busy !== ''} onChange={(event) => setVoiceRate(Number(event.target.value))} /></label>
          <label><Volume2 size={13} />Volumen de síntesis <span>{voiceVolume}%</span><input type="range" min={20} max={100} step={5} value={voiceVolume} disabled={busy !== ''} onChange={(event) => setVoiceVolume(Number(event.target.value))} /></label>
        </div>
        {!voiceProvider?.available && <p className="media-voice-warning"><AlertCircle size={14} />{voiceProvider?.error || 'Consultando motores de voz…'} Instala una voz de Windows para habilitar la síntesis.</p>}
        {selectedVoice && <p className="media-voice-note">Disponible: {selectedVoice.name} · {selectedVoice.language}. La velocidad solo cambia la lectura; no se altera ni acelera automáticamente después de generar.</p>}
        {project?.voiceAssetId && <p className="media-voice-warning"><AlertCircle size={14} />Este proyecto también tiene una narración grabada global. Para evitar duplicar audio, desvincula esa pista o las voces por escena antes de renderizar.</p>}
        {narratableScenes.length === 0 && <p className="media-voice-note">Aún no hay escenas con narración. El diálogo no se convierte automáticamente en una voz única.</p>}
        {unsavedVoiceScenes > 0 && <p className="media-voice-warning"><AlertCircle size={14} />Guarda la narración editada en cada escena antes de generarla; las solicitudes usan únicamente texto guardado.</p>}
      </section>

      <div className="media-editor-layout">
        <div className="media-scene-list">{project.scenes.map((scene) => {
          const draft = draftFor(scene);
          const visuals = assets.filter((asset) => ['image', 'video'].includes(asset.kind));
          return <article className="media-scene-card" key={scene.id}>
            <div className="media-scene-title"><span>ESCENA {scene.order + 1} · {draft.title || 'Sin título'}</span><label>Duración <input type="number" min={1} max={180} value={draft.durationSeconds} onChange={(event) => editScene(scene, 'durationSeconds', Number(event.target.value))} /> s</label></div>
            {scene.visualPending && <div className="media-plan-pending"><AlertCircle size={13} /> Material visual pendiente; asigna un recurso antes de considerar la escena lista.</div>}
            <label>Título<input maxLength={120} value={draft.title} onChange={(event) => editScene(scene, 'title', event.target.value)} /></label>
            <label>Objetivo narrativo<textarea rows={2} maxLength={300} value={draft.narrativeGoal} onChange={(event) => editScene(scene, 'narrativeGoal', event.target.value)} /></label>
            <label>Visual / notas<textarea rows={2} value={draft.visualDescription} onChange={(event) => editScene(scene, 'visualDescription', event.target.value)} /></label>
            <label>Narración<textarea rows={2} maxLength={3000} value={draft.voiceText} onChange={(event) => editScene(scene, 'voiceText', event.target.value)} /></label>
            {draft.voiceText.trim() && <div className="media-scene-voice">
              <div className="media-scene-voice-heading"><strong>Audio de narración</strong>
                {scene.voiceAudio?.active && <span className={scene.voiceAudio.stale ? 'media-voice-stale' : 'media-voice-ready'}>{scene.voiceAudio.stale ? 'Desactualizado' : 'Audio validado'}</span>}
                {!scene.voiceAudio?.active && scene.voiceGeneration && <span className={`media-voice-${scene.voiceGeneration.status}`}>{scene.voiceGeneration.status === 'queued' ? 'En cola' : scene.voiceGeneration.status === 'processing' ? 'Generando…' : scene.voiceGeneration.status === 'failed' ? 'Error' : scene.voiceGeneration.status === 'cancelled' ? 'Cancelado' : ''}</span>}
              </div>
              {scene.voiceAudio?.fileUrl && <>
                <audio controls preload="none" src={api.mediaVoiceUrl(scene.voiceAudio.id)} aria-label={`Escuchar narración de la escena ${scene.order + 1}`} />
                <small>{scene.voiceAudio.durationSeconds?.toFixed(1)} s reales · WAV {scene.voiceAudio.sampleRate ? `${Math.round(scene.voiceAudio.sampleRate / 1000)} kHz` : ''} · {scene.voiceAudio.voiceId}</small>
                {scene.voiceAudio.stale
                  ? <small className="media-voice-warning">El texto cambió desde esta versión. Regenera antes de renderizar para sincronizar voz y escena.</small>
                  : scene.voiceDurationUnavailable
                    ? <small className="media-voice-warning">No se pudo confirmar la duración real de este WAV; regenera la voz antes de renderizar.</small>
                    : scene.voiceTiming.needsMoreTime
                      ? <small className="media-voice-warning">Este WAV necesita {scene.voiceTiming.requiredDurationSeconds} s con el margen de {diagnostics?.limits.voiceSceneMarginSeconds ?? 0.5} s, pero tiene {scene.durationSeconds} s. {project.voiceTimingSummary.exceedsProjectLimit ? `La duración total necesaria sería ${project.voiceTimingSummary.requiredDurationSeconds} s; el límite del proyecto es 180 s. Reduce la duración de otras escenas.` : 'Se ajustará antes del render.'} No se recortará ni acelerará.</small>
                      : scene.voiceTiming.autoAdjusted
                        ? <small>Duración ajustada automáticamente: {scene.durationSeconds} s (estimación previa {scene.plannedDurationSeconds} s + margen de seguridad).</small>
                        : <small>Duración {scene.durationSource === 'manual' ? 'manual' : 'estimada'}: {scene.durationSeconds} s; el audio completo cabe con el margen configurado.</small>}
              </>}
              {scene.voiceGeneration?.status === 'failed' && <small className="media-voice-warning">{scene.voiceGeneration.error}</small>}
              {scene.voiceGeneration?.status === 'processing' && <progress className="media-progress" />}
              {scene.voiceGeneration && ['queued', 'processing'].includes(scene.voiceGeneration.status) && <button className="button secondary small-button" disabled={busy !== ''} onClick={() => void api.cancelMediaVoiceGeneration(scene.voiceGeneration!.id).then(() => api.mediaProject(project.id).then(setProject)).catch((reason) => setError((reason as Error).message))}>Cancelar generación</button>}
              <div className="media-voice-actions">
                <button className="button secondary small-button" disabled={busy !== '' || !voiceProvider?.available || pendingVoiceGenerations || draft.voiceText !== scene.voiceText} onClick={() => void performVoiceGeneration(scene)}><Mic size={13} />{busy === `voice-${scene.id}` ? 'Generando voz…' : scene.voiceAudio?.active ? 'Regenerar voz' : 'Generar voz'}</button>
                {scene.voiceAudio?.active && <button className="button secondary small-button" disabled={busy !== ''} onClick={() => void unlinkVoice(scene)}>{busy === `unlink-voice-${scene.id}` ? 'Desvinculando…' : 'Desvincular audio'}</button>}
              </div>
            </div>}
            <label>Diálogo<textarea rows={2} value={draft.dialogue} onChange={(event) => editScene(scene, 'dialogue', event.target.value)} /></label>
            <label>Subtítulo estimado<textarea rows={2} value={draft.subtitleText} onChange={(event) => editScene(scene, 'subtitleText', event.target.value)} /></label>
            <label>Título / texto en pantalla (zona superior)<textarea rows={1} value={draft.onScreenText} onChange={(event) => editScene(scene, 'onScreenText', event.target.value)} /></label>
            <details className="media-scene-direction"><summary>Dirección visual y continuidad</summary>
              <label>Tipo de plano<input maxLength={120} value={draft.shotType} onChange={(event) => editScene(scene, 'shotType', event.target.value)} /></label>
              <label>Movimiento de cámara<input maxLength={240} value={draft.cameraMovement} onChange={(event) => editScene(scene, 'cameraMovement', event.target.value)} /></label>
              <label>Acción<textarea rows={2} maxLength={500} value={draft.actionDescription} onChange={(event) => editScene(scene, 'actionDescription', event.target.value)} /></label>
              <label>Entorno<input maxLength={300} value={draft.environment} onChange={(event) => editScene(scene, 'environment', event.target.value)} /></label>
              <label>Iluminación<input maxLength={240} value={draft.lighting} onChange={(event) => editScene(scene, 'lighting', event.target.value)} /></label>
              <label>Paleta visual<input maxLength={120} value={draft.palette} onChange={(event) => editScene(scene, 'palette', event.target.value)} /></label>
              <label>Continuidad desde escena anterior<textarea rows={2} maxLength={300} value={draft.continuityBefore} onChange={(event) => editScene(scene, 'continuityBefore', event.target.value)} /></label>
              <label>Continuidad hacia siguiente escena<textarea rows={2} maxLength={300} value={draft.continuityAfter} onChange={(event) => editScene(scene, 'continuityAfter', event.target.value)} /></label>
              <label>Audio y ambiente<input maxLength={300} value={draft.audioNotes} onChange={(event) => editScene(scene, 'audioNotes', event.target.value)} /></label>
            </details>
            <div className="media-scene-controls"><label>Transición<select value={draft.transition} onChange={(event) => editScene(scene, 'transition', event.target.value as SceneDraft['transition'])}><option value="cut">Corte directo</option><option value="fade">Fundido (corte compatible)</option></select></label>
              <label>Recurso<select value={scene.asset?.id || ''} onChange={(event) => void assignAsset(scene, event.target.value)} disabled={busy === `asset-${scene.id}`}><option value="">Fondo de composición</option>{visuals.map((asset) => <option key={asset.id} value={asset.id}>{asset.kind.toUpperCase()} · {asset.originalName}</option>)}</select></label>
            </div>
            {scene.asset && <div className="media-assigned-asset"><Check size={13} /> Recurso asignado: {scene.asset.originalName}</div>}
            <button className="button secondary small-button" disabled={busy !== ''} onClick={() => void saveScene(scene)}><Save size={13} />{busy === `scene-${scene.id}` ? 'Guardando…' : 'Guardar escena'}</button>
          </article>;
        })}</div>
        <aside className="media-export-panel">
          <div className="media-preview-wrap"><div className="media-preview" style={{ aspectRatio: `${project.width} / ${project.height}` }}>
            {project.scenes[0]?.asset?.kind === 'image' && <img src={api.mediaAssetUrl(project.scenes[0].asset.id)} alt="" />}
            {project.scenes[0]?.asset?.kind === 'video' && <video src={api.mediaAssetUrl(project.scenes[0].asset.id)} muted controls />}
            {project.scenes[0]?.onScreenText && <span className="media-preview-title">{project.scenes[0].onScreenText}</span>}
            {project.scenes[0]?.subtitleText && <span className="media-preview-caption">{project.scenes[0].subtitleText}</span>}
          </div><small>Previsualización de composición · no es el video renderizado</small></div>
          <div className="media-export-options">
            <h3>Exportación MP4 vertical</h3>
            <label>Resolución<select value={project.width} onChange={(event) => void updateSettings({ width: Number(event.target.value) as 720 | 1080, height: Number(event.target.value) === 720 ? 1280 : 1920 })}><option value={720}>720 × 1280 · ligera</option><option value={1080}>1080 × 1920</option></select></label>
            <label>Duración objetivo<select value={project.durationSeconds} onChange={(event) => void updateSettings({ durationSeconds: Number(event.target.value) })}>{[15, 30, 45, 60].map((seconds) => <option key={seconds} value={seconds}>{seconds} segundos</option>)}{![15, 30, 45, 60].includes(project.durationSeconds) && <option value={project.durationSeconds}>{project.durationSeconds} segundos (actual)</option>}</select></label>
            <label>FPS<select value={project.fps} onChange={(event) => void updateSettings({ fps: Number(event.target.value) as MediaProject['fps'] })}>{[24, 25, 30, 60].map((fps) => <option key={fps}>{fps}</option>)}</select></label>
            <label>Calidad (CRF)<select value={project.crf} onChange={(event) => void updateSettings({ crf: Number(event.target.value) })}>{[20, 23, 25, 28, 32].map((crf) => <option key={crf}>{crf}</option>)}{![20, 23, 25, 28, 32].includes(project.crf) && <option value={project.crf}>{project.crf} · actual</option>}</select></label>
            <label className="media-checkbox"><input type="checkbox" checked={project.burnSubtitles} onChange={(event) => void updateSettings({ burnSubtitles: event.target.checked })} /> Integrar títulos y subtítulos con zonas seguras</label>
            <label>Narración grabada<select value={project.voiceAssetId || ''} onChange={(event) => void updateSettings({ voiceAssetId: event.target.value || null })}><option value="">Sin archivo de voz asignado</option>{assets.filter((asset) => asset.kind === 'audio').map((asset) => <option key={asset.id} value={asset.id}>{asset.originalName}</option>)}</select></label>
            <label>Música de fondo<select value={project.musicAssetId || ''} onChange={(event) => void updateSettings({ musicAssetId: event.target.value || null })}><option value="">Sin música asignada</option>{assets.filter((asset) => asset.kind === 'audio').map((asset) => <option key={asset.id} value={asset.id}>{asset.originalName}</option>)}</select></label>
            <p className={project.voiceTimingSummary.exceedsProjectLimit ? 'media-voice-warning' : 'media-estimate-note'}>
              Duración del proyecto: {project.durationSeconds} s · {project.voiceTimingSummary.confirmedVoiceScenes} narración(es) con WAV validado.
              {project.voiceTimingSummary.exceedsProjectLimit
                ? ` Las narraciones requieren ${project.voiceTimingSummary.requiredDurationSeconds} s; el máximo es ${project.voiceTimingSummary.projectLimitSeconds} s.`
                : ` Margen tras cada narración: ${project.voiceTimingSummary.marginSeconds} s.`}
            </p>
            {project.scenes.some((scene) => scene.subtitleText.trim()) && <p className="media-estimate-note">Los subtítulos se ajustan a un máximo de 3 líneas en una zona independiente; sus tiempos se estiman por escena, no por palabra. El SRT exportado contiene solo la narración.</p>}
            {pendingAiVisuals > 0 && <small className="media-plan-cost-note">{pendingAiVisuals} escena(s) necesitan imágenes o clips propios antes de renderizar este plan IA.</small>}
            <button className="button primary media-render-button" disabled={busy !== '' || !diagnosticInfo?.ffmpeg.available || !diagnosticInfo.ffprobe.available || activeJobs.some((job) => job.projectId === project.id) || pendingAiVisuals > 0} onClick={() => void startRender()}><Play size={15} />{busy === 'render' ? 'Encolando…' : 'Renderizar video real'}</button>
            {!diagnosticInfo?.ffmpeg.available && <small>Instala y detecta FFmpeg antes de renderizar.</small>}
          </div>
        </aside>
      </div>
    </section>}

    <div className="media-workbench media-bottom-grid">
      <section className="panel media-jobs-panel"><div className="panel-heading"><div><div className="eyebrow">PROCESOS LOCALES</div><h2>Cola de renderizado</h2><p>Progreso y estados reportados por FFmpeg, sin porcentajes simulados.</p></div><Clock3 size={16} className="muted-icon" /></div>
        {selectedProjectJobs.length ? <div className="media-job-list">{selectedProjectJobs.map((job) => <article className="media-job-row" key={job.id}>
          <span className={`media-job-indicator ${job.status}`} />
          <div className="media-job-main"><strong>{project?.title || projects.find((item) => item.id === job.projectId)?.title || 'Proyecto multimedia'}</strong><small>{job.stage} · {job.durationMs == null ? 'En curso' : `${(job.durationMs / 1000).toFixed(1)}s`}</small>
            {job.progress === null && activeStatuses.includes(job.status) ? <progress className="media-progress" /> : job.progress !== null && <progress className="media-progress" max={100} value={job.progress} />}
            {job.error && <small className="media-job-error">{job.error}</small>}
          </div>
          {activeStatuses.includes(job.status) && <button className="button secondary small-button" disabled={busy !== ''} onClick={() => void cancelJob(job)}>{busy === `cancel-${job.id}` ? 'Cancelando…' : 'Cancelar'}</button>}
          {job.status === 'failed' && <button className="button secondary small-button" disabled={busy !== ''} onClick={() => void retryJob(job)}>{busy === `retry-${job.id}` ? 'Reintentando…' : 'Reintentar'}</button>}
        </article>)}</div> : <div className="media-empty compact"><Video size={18} /><strong>Sin trabajos</strong><span>Los renderizados reales aparecerán aquí.</span></div>}
      </section>
      <section className="panel media-exports-panel"><div className="panel-heading"><div><div className="eyebrow">VALIDACIÓN TÉCNICA</div><h2>Exportaciones</h2><p>FFprobe confirma la estructura del archivo; la revisión visual independiente sigue siendo necesaria antes de publicar.</p></div><Download size={16} className="muted-icon" /></div>
        {exports.length ? exports.map((item) => <article className="media-export-row" key={item.id}><div><strong>{item.projectTitle}</strong><small>{item.width}×{item.height} · {item.durationSeconds.toFixed(1)}s · {item.videoCodec}{item.audioCodec ? ` + ${item.audioCodec}` : ''} · {fileSize(item.sizeBytes)}</small><small>{formatDate(item.createdAt)}</small><small>Técnica: {item.technicalValidationStatus === 'ffprobe_passed' ? 'FFprobe confirmada' : 'pendiente'} · Visual: {item.visualReviewStatus === 'pending' ? 'revisión manual pendiente' : item.visualReviewStatus === 'approved' ? 'aprobada manualmente' : 'requiere correcciones'}</small>{item.visualReviewedAt && <small>Revisión registrada: {formatDate(item.visualReviewedAt)}</small>}{item.visualReviewNote && <small>Nota: {item.visualReviewNote}</small>}</div><div className="media-export-actions"><video controls preload="none" src={api.mediaFileUrl(item.fileUrl)} /><a className="button secondary small-button" href={api.mediaFileUrl(item.fileUrl.replace('?inline=true', ''))} download><Download size={13} /> MP4</a>{item.subtitleUrl && <a className="text-link" href={api.mediaFileUrl(item.subtitleUrl)} download> SRT</a>}<button className="button secondary small-button" disabled={busy !== ''} onClick={() => void reviewExport(item, 'approved')}>{busy === `review-${item.id}` ? 'Guardando…' : 'Registrar aprobación visual'}</button><button className="button secondary small-button" disabled={busy !== ''} onClick={() => void reviewExport(item, 'needs_changes')}>Marcar requiere cambios</button></div></article>) : <div className="media-empty compact"><Download size={18} /><strong>Sin exportaciones</strong><span>Los resultados confirmados técnicamente aparecerán aquí; requieren revisión visual aparte.</span></div>}
      </section>
    </div>
    <footer className="media-footer-note">Genera narración local por escena con las voces instaladas de Windows o importa una grabación propia. No se realizan descargas de redes ni publicaciones externas. Límites actuales: {diagnostics ? `${Math.round(diagnostics.limits.maxUploadBytes / (1024 * 1024))} MiB por archivo · ${diagnostics.limits.maxConcurrent} trabajo(s) simultáneo(s)` : 'carga protegida'}.</footer>
  </div>;
}
