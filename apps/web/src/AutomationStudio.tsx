import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, AlertCircle, Clock3, Image, LoaderCircle, Play, Plus, RefreshCw, ShieldCheck, X,
} from 'lucide-react';
import {
  api, formatDate, type AiProviderId, type AutomationProviderState, type AutomationTask,
  type AutomationTaskType, type ImageGenerationCapabilities, type ResearchRecord,
} from './api';

type Notice = (notice: { kind: 'success' | 'error'; text: string }) => void;

const statusLabels: Record<AutomationTask['status'], string> = {
  queued: 'En cola',
  running: 'Ejecutando',
  waiting_for_authorization: 'Espera autorización',
  waiting_for_external_enabled: 'Operaciones externas desactivadas',
  waiting_for_quota: 'Espera cuota',
  succeeded: 'Completada',
  failed: 'Fallida',
  cancelled: 'Cancelada',
};

const typeLabels: Record<AutomationTaskType, string> = {
  research: 'Investigación web',
  proposal: 'Propuesta de contenido',
  image_generation: 'Generación de imagen',
  media_preflight: 'Comprobación local de Media Studio',
};

const providerLabels: Record<AutomationProviderState['status'], string> = {
  unknown: 'Desconocido · no se ha probado',
  available: 'Disponible según la última operación',
  not_configured: 'No configurado',
  rate_limited: 'Límite o cuota informado',
  quota_limited: 'Cuota agotada',
  authentication_error: 'Error de autenticación',
  permission_error: 'Permiso insuficiente',
  model_unavailable: 'Modelo no disponible',
  timeout: 'Tiempo de espera agotado',
  unavailable: 'Error de disponibilidad',
};

const activeStatuses = new Set<AutomationTask['status']>([
  'queued', 'running', 'waiting_for_authorization', 'waiting_for_external_enabled', 'waiting_for_quota',
]);

function isAiProviderId(provider: string): provider is AiProviderId {
  return provider === 'gemini' || provider === 'groq' || provider === 'ollama';
}

export default function AutomationStudio({ onNotice }: { onNotice: Notice }) {
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [providers, setProviders] = useState<AutomationProviderState[]>([]);
  const [externalOperationsEnabled, setExternalOperationsEnabled] = useState(false);
  const [researches, setResearches] = useState<ResearchRecord[]>([]);
  const [imageCapabilities, setImageCapabilities] = useState<ImageGenerationCapabilities | null>(null);
  const [type, setType] = useState<AutomationTaskType>('media_preflight');
  const [researchInput, setResearchInput] = useState({
    niche: '', audience: '', market: 'México', language: 'Español', goal: 'Informar', format: 'Explicativo', durationSeconds: 30,
  });
  const [researchId, setResearchId] = useState('');
  const [proposalProvider, setProposalProvider] = useState<AiProviderId>('ollama');
  const [imagePrompt, setImagePrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function refresh(showLoading = false) {
    if (showLoading) setLoading(true);
    try {
      const [taskResponse, providerResponse, researchResponse, imageResponse, settingsResponse] = await Promise.all([
        api.automationTasks(),
        api.automationProviders(),
        api.researches(),
        api.mediaImageGenerationCapabilities(),
        api.automationSettings(),
      ]);
      setTasks(taskResponse.tasks);
      setProviders(providerResponse.providers);
      setResearches(researchResponse);
      setImageCapabilities(imageResponse);
      setExternalOperationsEnabled(settingsResponse.externalOperationsEnabled);
      setError('');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh(true);
    const interval = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(interval);
  }, []);

  async function enqueue(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      let input: Record<string, unknown>;
      if (type === 'research') input = { type, input: researchInput };
      else if (type === 'proposal') input = { type, researchId, provider: selectedProposalProvider };
      else if (type === 'image_generation') {
        input = {
          type,
          provider: 'gemini',
          model: imageCapabilities?.model || '',
          prompt: imagePrompt,
        };
      } else input = { type: 'media_preflight' };
      const response = await api.enqueueAutomationTask(input, crypto.randomUUID());
      await refresh();
      onNotice({
        kind: 'success',
        text: response.task.status === 'waiting_for_authorization'
          ? 'Tarea creada. Autoriza explícitamente la operación externa para iniciarla.'
          : 'Tarea local encolada.',
      });
    } catch (cause) {
      onNotice({ kind: 'error', text: (cause as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  async function authorize(task: AutomationTask) {
    const operation = task.type === 'research'
      ? 'enviar a Google el tema y los datos de audiencia para investigar en la web'
      : task.type === 'image_generation'
        ? 'solicitar a Gemini la generación de una imagen, que podría consumir cuota o generar cargos'
        : 'enviar la solicitud de propuesta al proveedor de IA seleccionado, que podría consumir cuota o generar cargos';
    if (!window.confirm(`¿Autorizas ${operation}?`)) return;
    try {
      await api.authorizeAutomationTask(task.id);
      await refresh();
      onNotice({ kind: 'success', text: 'Autorización registrada; la tarea se inició o quedó en cola.' });
    } catch (cause) {
      onNotice({ kind: 'error', text: (cause as Error).message });
    }
  }

  async function cancel(task: AutomationTask) {
    try {
      await api.cancelAutomationTask(task.id);
      await refresh();
      onNotice({ kind: 'success', text: 'Se solicitó la cancelación de la tarea.' });
    } catch (cause) {
      onNotice({ kind: 'error', text: (cause as Error).message });
    }
  }

  async function retry(task: AutomationTask) {
    const confirmed = !task.external || window.confirm('El nuevo intento puede consumir cuota o generar cargos. ¿Autorizas otro intento externo?');
    if (!confirmed) return;
    try {
      await api.retryAutomationTask(task.id, confirmed && task.external);
      await refresh();
      onNotice({ kind: 'success', text: 'Tarea reencolada.' });
    } catch (cause) {
      onNotice({ kind: 'error', text: (cause as Error).message });
    }
  }

  async function saveImage(task: AutomationTask) {
    const previewId = task.result?.previewId;
    if (typeof previewId !== 'string') return;
    try {
      await api.saveGeneratedMediaImage(previewId);
      onNotice({ kind: 'success', text: 'Imagen guardada en la Biblioteca multimedia.' });
    } catch (cause) {
      onNotice({ kind: 'error', text: (cause as Error).message });
    }
  }

  async function setExternalOperations(enabled: boolean) {
    if (enabled && !window.confirm('Al habilitar las operaciones externas, las funciones de VYRALIX podrán enviar solicitudes nuevas a proveedores y podrían consumir cuota o generar cargos. ¿Continuar?')) return;
    try {
      const settings = await api.setAutomationExternalOperations(enabled);
      setExternalOperationsEnabled(settings.externalOperationsEnabled);
      await refresh();
      onNotice({
        kind: 'success',
        text: enabled ? 'Operaciones externas habilitadas explícitamente.' : 'Nuevas operaciones externas bloqueadas.',
      });
    } catch (cause) {
      onNotice({ kind: 'error', text: (cause as Error).message });
    }
  }

  const completedResearch = researches.filter((research) => research.status === 'completed');
  const configuredTextProviders = providers.filter((provider) => provider.configured && isAiProviderId(provider.provider));
  const selectedProposalProvider = configuredTextProviders.some((provider) => provider.provider === proposalProvider)
    ? proposalProvider
    : (configuredTextProviders[0]?.provider || 'ollama');
  return <>
    <div className="page-heading">
      <div><div className="eyebrow">ORQUESTACIÓN PERSISTENTE</div><h1>Automatizaciones</h1><p>Trabajos locales y externos en SQLite, con autorización explícita y recuperación segura.</p></div>
      <div className="heading-actions"><button className="button secondary" onClick={() => void refresh(true)}><RefreshCw size={15} /> Actualizar</button></div>
    </div>
    <div className="notice-card automation-notice"><div className="notice-icon"><ShieldCheck size={18} /></div><div><strong>Operaciones externas {externalOperationsEnabled ? 'habilitadas' : 'desactivadas'}</strong><p>Este interruptor bloquea nuevas llamadas a Gemini y Groq, búsqueda web, generación de imágenes y planificación externa, tanto desde esta cola como desde las demás funciones. Las operaciones locales y las solicitudes externas que ya comenzaron no se cancelan. No garantiza costo cero ni controla procesos ajenos a VYRALIX.</p><p>Si el servidor se reinicia durante una solicitud externa de la cola, el resultado se marca incierto y no se repite automáticamente.</p></div><button className={`button ${externalOperationsEnabled ? 'secondary' : 'primary'} small-button`} onClick={() => void setExternalOperations(!externalOperationsEnabled)}>{externalOperationsEnabled ? 'Desactivar' : 'Habilitar explícitamente'}</button></div>
    {error && <div className="error-banner" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}

    <section className="panel automation-create">
      <div className="panel-heading"><div><h2>Crear tarea</h2><p>Las solicitudes se deduplican con una clave única y conservan sus estados.</p></div></div>
      <form onSubmit={(event) => void enqueue(event)} className="automation-form">
        <label>Tipo de tarea<select value={type} onChange={(event) => setType(event.target.value as AutomationTaskType)}>
          <option value="media_preflight">Comprobación local de Media Studio</option>
          <option value="research">Investigar un tema con Google Search</option>
          <option value="proposal">Crear propuesta desde investigación existente</option>
          <option value="image_generation">Generar imagen con Gemini</option>
        </select></label>
        {type === 'research' && <div className="automation-fields">
          <label>Tema o nicho<input required minLength={2} maxLength={80} value={researchInput.niche} onChange={(event) => setResearchInput({ ...researchInput, niche: event.target.value })} /></label>
          <label>Audiencia<input required minLength={2} maxLength={120} value={researchInput.audience} onChange={(event) => setResearchInput({ ...researchInput, audience: event.target.value })} /></label>
          <label>Mercado<input required minLength={2} maxLength={80} value={researchInput.market} onChange={(event) => setResearchInput({ ...researchInput, market: event.target.value })} /></label>
          <label>Idioma<input required minLength={2} maxLength={40} value={researchInput.language} onChange={(event) => setResearchInput({ ...researchInput, language: event.target.value })} /></label>
          <label>Objetivo<input required minLength={2} maxLength={100} value={researchInput.goal} onChange={(event) => setResearchInput({ ...researchInput, goal: event.target.value })} /></label>
          <label>Formato<input required minLength={2} maxLength={60} value={researchInput.format} onChange={(event) => setResearchInput({ ...researchInput, format: event.target.value })} /></label>
          <label>Duración (segundos)<input type="number" min={15} max={180} required value={researchInput.durationSeconds} onChange={(event) => setResearchInput({ ...researchInput, durationSeconds: Number(event.target.value) })} /></label>
        </div>}
        {type === 'proposal' && <>
          <label>Investigación<select required value={researchId} onChange={(event) => setResearchId(event.target.value)}>
            <option value="">Selecciona investigación completada</option>
            {completedResearch.map((research) => <option key={research.id} value={research.id}>{research.request.niche} · {formatDate(research.updatedAt)}</option>)}
          </select></label>
          <label>Proveedor<select required disabled={!configuredTextProviders.length} value={selectedProposalProvider} onChange={(event) => {
            if (isAiProviderId(event.target.value)) setProposalProvider(event.target.value);
          }}>
            {configuredTextProviders.map((provider) => <option key={provider.provider} value={provider.provider}>{provider.provider}{provider.model ? ` · ${provider.model}` : ''}{provider.provider !== 'ollama' ? ' · externo' : ' · local'}</option>)}
          </select></label>
          {!configuredTextProviders.length && <p className="automation-form-hint">No hay proveedor de texto configurado para propuestas. Puedes seguir usando tareas locales.</p>}
        </>}
        {type === 'image_generation' && <label>Descripción de imagen<textarea required minLength={5} maxLength={2000} value={imagePrompt} onChange={(event) => setImagePrompt(event.target.value)} placeholder="Describe la imagen que quieres crear." /><small>{imageCapabilities?.enabled ? `Gemini · ${imageCapabilities.model} · puede consumir cuota o generar cargos.` : `Generación no configurada: ${imageCapabilities?.missing.join(', ') || 'cargando capacidades'}.`}</small></label>}
        <button className="button primary" type="submit" disabled={submitting || (type === 'proposal' && (completedResearch.length === 0 || !configuredTextProviders.length)) || (type === 'image_generation' && !imageCapabilities?.enabled)}>
          {submitting ? <LoaderCircle size={15} className="spin" /> : <Plus size={16} />}
          {submitting ? 'Encolando...' : 'Crear tarea'}
        </button>
      </form>
    </section>

    <section className="panel automation-providers">
      <div className="panel-heading"><div><h2>Estado conocido de proveedores</h2><p>Se muestra configuración y resultados recientes; no se consultan APIs para sondear cuotas.</p></div></div>
      <div className="automation-provider-grid">{providers.map((provider) => <div className="automation-provider" key={provider.provider}>
        <strong>{provider.provider}{provider.model ? <small>{provider.model}</small> : null}</strong>
        <span className={`status-badge ${provider.status === 'available' ? 'completed' : provider.status === 'unknown' ? 'pending' : 'error'}`}>{provider.configured ? providerLabels[provider.status] : 'No configurado'}</span>
        {provider.retryAt && <small>Retry-After: {formatDate(provider.retryAt, { hour: '2-digit', minute: '2-digit' })}</small>}
      </div>)}</div>
    </section>

    <section className="panel automation-queue">
      <div className="panel-heading"><div><h2>Cola e historial</h2><p>{tasks.length} tareas · progreso solo cuando puede medirse</p></div></div>
      {loading && !tasks.length ? <div className="empty-state"><LoaderCircle className="spin" size={18} /><p>Cargando tareas guardadas...</p></div>
        : tasks.length ? <div className="automation-task-list">{tasks.map((task) => {
          const imagePreviewId = typeof task.result?.previewId === 'string' ? task.result.previewId : null;
          const researchResultId = typeof task.result?.researchId === 'string' ? task.result.researchId : null;
          return <article className="automation-task" key={task.id}>
            <div className="automation-task-main">
              <div className="automation-task-title"><strong>{typeLabels[task.type]}</strong><span className={`status-badge ${task.status}`}>{statusLabels[task.status]}</span></div>
              <p>{task.stage}</p>
              <div className="automation-task-meta">
                <span>{task.provider || 'Local'}{task.model ? ` · ${task.model}` : ''}</span>
                <span>{task.attempts}/{task.maxAttempts} intentos</span>
                <span>Creada {formatDate(task.createdAt, { hour: '2-digit', minute: '2-digit' })}</span>
                {task.nextAttemptAt && <span>Revisar después de {formatDate(task.nextAttemptAt, { hour: '2-digit', minute: '2-digit' })}</span>}
              </div>
              {task.error && <div className="automation-task-error"><AlertCircle size={14} />{task.error}</div>}
              {researchResultId && <Link className="text-link" to="/investigacion">Abrir investigación guardada <span aria-hidden="true">→</span></Link>}
              {task.type === 'proposal' && task.status === 'succeeded' && <Link className="text-link" to="/investigacion">Revisar borrador en Tendencias e ideas <span aria-hidden="true">→</span></Link>}
              {imagePreviewId && <div className="automation-preview">
                <img src={api.generatedMediaImageUrl(imagePreviewId)} alt="Previsualización temporal generada por Gemini" />
                <div><small>Previsualización temporal; guárdala en biblioteca para conservarla.</small><button className="button secondary small-button" onClick={() => void saveImage(task)}><Image size={14} /> Guardar en biblioteca</button></div>
              </div>}
            </div>
            <div className="automation-task-actions">
              {task.status === 'waiting_for_authorization' && <button className="button primary small-button" onClick={() => void authorize(task)}><ShieldCheck size={14} /> Autorizar</button>}
              {task.status === 'waiting_for_quota' && <span className="quota-wait"><Clock3 size={14} /> Esperando proveedor</span>}
              {task.status === 'waiting_for_external_enabled' && <span className="quota-wait"><ShieldCheck size={14} /> Espera activación global</span>}
              {task.status === 'failed' && task.errorCode !== 'external_outcome_unknown' && <button className="button secondary small-button" onClick={() => void retry(task)}><Play size={14} /> Reintentar</button>}
              {task.status === 'waiting_for_quota' && <button className="button secondary small-button" onClick={() => void retry(task)}><Play size={14} /> Reintentar manual</button>}
              {activeStatuses.has(task.status) && <button className="button secondary small-button" onClick={() => void cancel(task)}><X size={14} /> Cancelar</button>}
            </div>
          </article>;
        })}</div> : <div className="empty-state"><Activity size={22} /><strong>No hay tareas todavía</strong><p>Encola una comprobación local o prepara una investigación, propuesta o imagen.</p></div>}
    </section>
  </>;
}
