import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, Check, Clock3, LoaderCircle, RefreshCw, Save, Sparkles, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, formatDate, type AiGeneration, type AiGenerationInput, type AiProvider, type AiProviderId, type AiVariant } from './api';

type Notice = { kind: 'success' | 'error'; text: string } | null;

const initialForm: AiGenerationInput = {
  category: 'Entretenimiento',
  audience: 'Público general adulto',
  tone: 'natural, ágil y cercano',
  creativeGoal: 'captar atención y ofrecer valor',
  format: 'libre',
  durationSeconds: 30,
  variants: 2,
  restrictions: '',
  provider: 'auto',
};

const categories = [
  'Memes originales', 'Tendencias', 'Entretenimiento', 'Historias originales',
  'Curiosidades', 'Noticias verificadas', 'Contenido educativo ligero',
];
const providerNames: Record<AiProviderId, string> = { gemini: 'Gemini', groq: 'Groq', ollama: 'Ollama local' };
const availabilityLabels: Record<AiProvider['availability'], string> = {
  unknown: 'Disponibilidad desconocida',
  available: 'Disponible',
  unavailable: 'Sin conexión',
  model_invalid: 'Modelo no disponible',
  error: 'Error de comprobación',
};

export default function AiGenerator({ onNotice }: { onNotice: (notice: Notice) => void }) {
  const [form, setForm] = useState<AiGenerationInput>(initialForm);
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [history, setHistory] = useState<AiGeneration[]>([]);
  const [current, setCurrent] = useState<AiGeneration | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingVariant, setSavingVariant] = useState<number | null>(null);
  const [discardingVariant, setDiscardingVariant] = useState<number | null>(null);
  const [editing, setEditing] = useState<Record<number, AiVariant>>({});
  const generatingRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [providerData, generations] = await Promise.all([api.aiProviders(), api.aiGenerations()]);
      setProviders(providerData.providers);
      setHistory(generations);
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    setEditing({});
  }, [current?.id]);

  const configured = providers.filter((provider) => provider.configured);
  const providerOptions = providers.map((provider) => (
    <option key={provider.id} value={provider.id} disabled={!provider.configured}>
      {provider.name}{provider.configured ? ` · ${availabilityLabels[provider.availability]}` : ` · Falta ${provider.missing.join(', ')}`}
    </option>
  ));

  function change<K extends keyof AiGenerationInput>(key: K, value: AiGenerationInput[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  async function checkProviders() {
    setChecking(true);
    try {
      const result = await api.checkAiProviders();
      setProviders(result.providers);
      onNotice({ kind: 'success', text: 'Comprobación de proveedores terminada.' });
    } catch (reason) {
      onNotice({ kind: 'error', text: (reason as Error).message });
    } finally {
      setChecking(false);
    }
  }

  async function runGeneration(variationContext?: string) {
    if (generatingRef.current) return;
    generatingRef.current = true;
    setGenerating(true);
    setError('');
    const idempotencyKey = crypto.randomUUID();
    setActiveId(idempotencyKey);
    try {
      const generation = await api.generateAi({
        ...form,
        variants: variationContext ? 1 : form.variants,
        ...(variationContext ? { variationContext } : {}),
      }, idempotencyKey);
      setCurrent(generation);
      setActiveId(generation.id);
      await refresh();
      if (generation.status === 'completed') {
        onNotice({ kind: 'success', text: `Generación completada con ${providerNames[generation.provider!]}.` });
      }
    } catch (reason) {
      setError((reason as Error).message);
      try {
        const failedOrPending = await api.aiGeneration(idempotencyKey);
        setCurrent(failedOrPending);
      } catch {
        setCurrent(null);
      }
      await refresh();
    } finally {
      generatingRef.current = false;
      setGenerating(false);
    }
  }

  async function openGeneration(id: string) {
    setActiveId(id);
    setError('');
    try {
      setCurrent(await api.aiGeneration(id));
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function saveVariant(index: number, variant: AiVariant) {
    if (!current || savingVariant !== null) return;
    setSavingVariant(index);
    setError('');
    try {
      await api.saveAiVariant(current.id, index, variant);
      const updated = await api.aiGeneration(current.id);
      setCurrent(updated);
      await refresh();
      onNotice({ kind: 'success', text: 'Variante guardada como borrador en el centro de contenido.' });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSavingVariant(null);
    }
  }

  async function discardVariant(index: number) {
    if (!current || discardingVariant !== null) return;
    setDiscardingVariant(index);
    try {
      await api.discardAiVariant(current.id, index);
      setCurrent(await api.aiGeneration(current.id));
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setDiscardingVariant(null);
    }
  }

  function updateVariant(index: number, key: 'title' | 'hook' | 'idea' | 'script' | 'description', value: string) {
    const variant = current?.variants[index];
    if (!variant) return;
    setEditing((previous) => ({
      ...previous,
      [index]: { ...(previous[index] || variant), [key]: value },
    }));
  }

  const activeHistory = history.find((item) => item.id === activeId);
  const displayGeneration = current || activeHistory || null;

  useEffect(() => {
    if (!current || current.status !== 'pending') return;
    const interval = window.setInterval(() => {
      void api.aiGeneration(current.id).then((updated) => {
        setCurrent(updated);
        if (updated.status !== 'pending') void refresh();
      }).catch((reason: Error) => setError(reason.message));
    }, 2000);
    return () => window.clearInterval(interval);
  }, [current?.id, current?.status, refresh]);

  return <>
    <div className="page-heading"><div><div className="eyebrow">PRODUCCIÓN CREATIVA</div><h1>Generador con IA</h1><p>Genera guiones originales para TikTok con proveedores configurados por ti.</p></div><div className="heading-actions"><button className="button secondary" onClick={() => void checkProviders()} disabled={checking}><RefreshCw size={15} className={checking ? 'spin' : ''} />{checking ? 'Comprobando...' : 'Comprobar proveedores'}</button></div></div>
    <div className="ai-privacy-note"><span><AlertCircle size={16} /></span><div><strong>El texto de la solicitud se enviará al proveedor elegido.</strong><p>Los proveedores alojados pueden generar costos según el plan de tu cuenta. En modo automático, los proveedores alojados posteriores al primero solo se usan como fallback si activas explícitamente *_AUTO_FALLBACK=true. Ollama se ejecuta localmente. No se envía nada si ningún proveedor está configurado.</p></div></div>
    {error && <div className="error-banner"><AlertCircle size={17} /><span>{error}</span><button onClick={() => setError('')}>Cerrar</button></div>}
    <div className="ai-layout">
      <div className="ai-main-column">
        <section className="panel ai-form-panel">
          <div className="panel-heading"><div><h2>Define tu contenido</h2><p>Personaliza el estilo para crear variantes listas para revisar.</p></div><Sparkles size={17} className="ai-sparkle" /></div>
          {!loading && configured.length === 0 && <div className="ai-no-provider"><AlertCircle size={15} /><span>No hay proveedor listo. Configura API y modelo desde <b>.env</b> y reinicia VYRALIX; el resto de la aplicación seguirá disponible.</span></div>}
          <form className="ai-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void runGeneration(); }}>
            <div className="form-row"><label>Categoría<select value={form.category} onChange={(event) => change('category', event.target.value)}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label><label>Proveedor<select value={form.provider} onChange={(event) => change('provider', event.target.value as AiGenerationInput['provider'])}><option value="auto">Automático · según prioridad</option>{providerOptions}</select></label></div>
            <div className="form-row"><label>Público objetivo<input maxLength={240} value={form.audience} onChange={(event) => change('audience', event.target.value)} /></label><label>Tono<input maxLength={120} value={form.tone} onChange={(event) => change('tone', event.target.value)} /></label></div>
            <label>Objetivo creativo<input maxLength={300} value={form.creativeGoal} onChange={(event) => change('creativeGoal', event.target.value)} /></label>
            <div className="form-row"><label>Formato<select value={form.format} onChange={(event) => change('format', event.target.value as AiGenerationInput['format'])}><option value="libre">Libre</option><option value="storytime">Storytime</option><option value="lista">Lista</option><option value="sketch">Sketch</option><option value="explicativo">Explicativo</option><option value="pregunta">Pregunta</option></select></label><label>Duración objetivo <span className="field-suffix">segundos</span><input type="number" min={10} max={180} value={form.durationSeconds} onChange={(event) => change('durationSeconds', Number(event.target.value))} /></label></div>
            <div className="form-row"><label>Variantes<select value={form.variants} onChange={(event) => change('variants', Number(event.target.value))}><option value={1}>1 variante</option><option value={2}>2 variantes</option><option value={3}>3 variantes</option><option value={4}>4 variantes</option></select></label><label>Restricciones (opcional)<input maxLength={1200} value={form.restrictions} onChange={(event) => change('restrictions', event.target.value)} placeholder="Temas o enfoques que quieres evitar" /></label></div>
            <button className="button primary ai-generate-button" disabled={generating || configured.length === 0 || form.audience.trim().length < 2 || form.tone.trim().length < 2 || form.creativeGoal.trim().length < 2}>{generating ? <><LoaderCircle size={16} className="spin" /> Generando con el proveedor...</> : <><Sparkles size={16} /> Generar {form.variants > 1 ? `${form.variants} variantes` : 'contenido'}</>}</button>
            <p className="ai-usage-note">Uso medido cuando el proveedor lo informa. Costos desconocidos hasta tener datos verificables del plan y la cuenta.</p>
          </form>
        </section>

        {displayGeneration && <section className="ai-results-section">
          <div className="panel-heading results-heading"><div><div className="eyebrow">RESULTADO</div><h2>{displayGeneration.status === 'failed' ? 'Generación con error' : displayGeneration.status === 'pending' ? 'Generación en curso' : 'Variantes generadas'}</h2><p>{displayGeneration.provider ? `${providerNames[displayGeneration.provider]} · ${displayGeneration.model}` : 'Sin proveedor' } · {formatDate(displayGeneration.createdAt, { hour: '2-digit', minute: '2-digit' })} · {displayGeneration.attempts} intento(s)</p></div>{displayGeneration.status === 'pending' ? <span className="status-badge pending"><LoaderCircle size={12} className="spin" /> Procesando</span> : displayGeneration.status === 'completed' && <span className="status-badge completed"><Check size={12} /> Respuesta real validada</span>}</div>
          {displayGeneration.status === 'failed' && <div className="error-banner"><AlertCircle size={16} /><span>{displayGeneration.error?.message || 'No se pudo generar.'} ({displayGeneration.error?.code})</span></div>}
          {displayGeneration.fallbackReason && <div className="ai-fallback-note">Cambio automático de proveedor: {displayGeneration.fallbackReason}</div>}
          {displayGeneration.usage && <div className="ai-usage-chip">Tokens informados por el proveedor: entrada {displayGeneration.usage.inputTokens ?? '—'} · salida {displayGeneration.usage.outputTokens ?? '—'} · costo desconocido</div>}
          {displayGeneration.variants.filter((variant) => !variant.discarded).map((variant) => {
            const draft = editing[variant.index] || variant;
            const busy = savingVariant === variant.index || discardingVariant === variant.index || generating;
            return <article className="panel ai-variant-card" key={`${displayGeneration.id}-${variant.index}`}>
              <div className="variant-heading"><span className="variant-number">VARIANTE {variant.index + 1}</span><span className="variant-format">{draft.format} · {draft.durationSeconds}s</span></div>
              <label className="variant-field">Título interno<input value={draft.title} onChange={(event) => updateVariant(variant.index, 'title', event.target.value)} disabled={Boolean(variant.savedPostId) || busy} /></label>
              <div className="variant-hook"><span>GANCHO</span><textarea rows={2} value={draft.hook} onChange={(event) => updateVariant(variant.index, 'hook', event.target.value)} disabled={Boolean(variant.savedPostId) || busy} /></div>
              <label className="variant-field">Idea principal<textarea rows={2} value={draft.idea} onChange={(event) => updateVariant(variant.index, 'idea', event.target.value)} disabled={Boolean(variant.savedPostId) || busy} /></label>
              <label className="variant-field">Guion<textarea rows={6} value={draft.script} onChange={(event) => updateVariant(variant.index, 'script', event.target.value)} disabled={Boolean(variant.savedPostId) || busy} /></label>
              <label className="variant-field">Descripción<textarea rows={2} value={draft.description} onChange={(event) => updateVariant(variant.index, 'description', event.target.value)} disabled={Boolean(variant.savedPostId) || busy} /></label>
              <label className="variant-field">Hashtags (separados por coma)<input value={draft.hashtags.map((tag) => `#${tag.replace(/^#/, '')}`).join(' ')} onChange={(event) => setEditing((previous) => ({ ...previous, [variant.index]: { ...(previous[variant.index] || variant), hashtags: event.target.value.split(/[\s,]+/).filter(Boolean) } }))} disabled={Boolean(variant.savedPostId) || busy} /></label>
              <div className="variant-tags">{draft.hashtags.map((tag) => <i key={tag}>#{tag.replace(/^#/, '')}</i>)}</div>
              {draft.imageText && <div className="variant-extra"><strong>Texto para imagen</strong><span>{draft.imageText}</span></div>}
              {draft.mediaPrompt && <div className="variant-extra"><strong>Prompt multimedia</strong><span>{draft.mediaPrompt}</span></div>}
              {draft.warnings.length > 0 && <div className="variant-warnings"><AlertCircle size={13} />{draft.warnings.join(' · ')}</div>}
              <div className="variant-actions">
                {variant.savedPostId
                  ? <span className="saved-state"><Check size={14} /> Borrador guardado · {variant.savedPostId.slice(0, 8)}</span>
                  : <><button className="button primary" disabled={busy} onClick={() => void saveVariant(variant.index, draft)}>{savingVariant === variant.index ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}{savingVariant === variant.index ? 'Guardando...' : 'Guardar como borrador'}</button><button className="button secondary" disabled={busy} onClick={() => void runGeneration(`${variant.idea}\nGancho previo: ${variant.hook}`)}><RefreshCw size={13} /> Regenerar</button><button className="icon-button discard-button" title="Descartar variante" aria-label="Descartar variante" disabled={busy} onClick={() => void discardVariant(variant.index)}>{discardingVariant === variant.index ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}</button></>}
              </div>
            </article>;
          })}
          {!displayGeneration.variants.length && displayGeneration.status === 'completed' && <div className="empty-state"><strong>Sin variantes visibles</strong><p>Las variantes se descartaron o no están disponibles.</p></div>}
          {!!displayGeneration.providerAttempts.length && <details className="ai-attempt-details"><summary>Detalle de solicitudes a proveedores ({displayGeneration.providerAttempts.length})</summary>{displayGeneration.providerAttempts.map((attempt, index) => <div className="ai-attempt-row" key={`${attempt.provider}-${attempt.attempt}-${index}`}><span>{providerNames[attempt.provider]} · {attempt.outcome === 'success' ? 'Correcto' : attempt.errorCode}</span><span>{attempt.durationMs} ms · intento {attempt.attempt}</span>{attempt.retryAfterSeconds != null && <span>Retry-After {attempt.retryAfterSeconds}s</span>}</div>)}</details>}
        </section>}
      </div>
      <aside className="ai-side-column">
        <section className="panel provider-status-panel"><div className="panel-heading"><div><h2>Proveedores</h2><p>Configuración y disponibilidad comprobada</p></div><Sparkles size={16} className="muted-icon" /></div>
          {loading ? <div className="loading-state compact"><LoaderCircle size={17} className="spin" />Cargando proveedores...</div> : providers.map((provider) => <div className="provider-status-row" key={provider.id}><div className={`provider-avatar ${provider.id}`}>{provider.name.slice(0, 1)}</div><div className="provider-info"><strong>{provider.name}</strong><small>{provider.configured ? provider.model : `Falta ${provider.missing.join(', ')}`}</small><small>{provider.configured ? `${availabilityLabels[provider.availability]} · Fallback automático: ${provider.autoFallbackAllowed ? 'sí' : 'no'}${provider.mayIncurCost ? ' · tarifa de cuenta desconocida' : ' · local'}` : 'No configurado'}</small></div><span className={`provider-light ${provider.configured ? provider.availability : 'unknown'}`} /></div>)}
          <Link className="text-link provider-settings-link" to="/configuracion">Prioridad y detalle de proveedores →</Link>
        </section>
        <section className="panel history-panel"><div className="panel-heading"><div><h2>Historial</h2><p>Solicitudes persistidas en SQLite</p></div><Clock3 size={15} className="muted-icon" /></div>
          {history.length ? <div className="generation-history">{history.map((generation) => <button className={`history-item${activeId === generation.id ? ' active' : ''}`} key={generation.id} onClick={() => void openGeneration(generation.id)}><span className={`history-status ${generation.status}`} /><span><strong>{generation.request.category}</strong><small>{generation.provider ? providerNames[generation.provider] : generation.error?.code || 'En curso'} · {formatDate(generation.createdAt, { hour: '2-digit', minute: '2-digit' })}</small></span><span className="history-count">{generation.variants.length || '—'}</span></button>)}</div> : <div className="empty-state history-empty"><Clock3 size={18} /><strong>Sin generaciones todavía</strong><p>Tu historial aparecerá después de usar un proveedor real.</p></div>}
        </section>
      </aside>
    </div>
  </>;
}
