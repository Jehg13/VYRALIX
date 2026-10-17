import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, ArrowRight, Check, ExternalLink, LoaderCircle, RefreshCw, Search, Sparkles, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, type AiProvider, type AiProviderId, type ResearchInput, type ResearchProposal, type ResearchRecord } from './api';

type Notice = { kind: 'success' | 'error'; text: string } | null;
type SearchForm = Omit<ResearchInput, 'confirmExternalSearch'>;

const initialForm: SearchForm = {
  niche: '',
  audience: 'Público general adulto',
  market: 'México',
  language: 'Español',
  goal: 'Informar y entretener',
  format: 'Explicativo',
  durationSeconds: 30,
};
const evidenceLabels = { reported: 'Reportado por fuente', inference: 'Inferencia', needs_verification: 'Requiere verificación' };

export default function ResearchStudio({ onNotice }: { onNotice: (notice: Notice) => void }) {
  const navigate = useNavigate();
  const [form, setForm] = useState(initialForm);
  const [capabilities, setCapabilities] = useState<Awaited<ReturnType<typeof api.researchCapabilities>> | null>(null);
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [records, setRecords] = useState<ResearchRecord[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [provider, setProvider] = useState<AiProviderId>('gemini');
  const [confirmSearch, setConfirmSearch] = useState(false);
  const [confirmCost, setConfirmCost] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<ResearchProposal | null>(null);
  const [saved, setSaved] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const selected = records.find((record) => record.id === selectedId) || null;
  const usableProviders = providers.filter((item) => item.configured && item.capabilities.includes('structured_text'));
  const selectedProvider = usableProviders.find((item) => item.id === provider);
  const hasProposalChanges = Boolean(editing && selected?.proposal && JSON.stringify(editing) !== JSON.stringify(selected.proposal));

  useEffect(() => {
    let active = true;
    void Promise.all([api.researchCapabilities(), api.researches(), api.aiProviders()])
      .then(([capabilityData, researchData, providerData]) => {
        if (!active) return;
        setCapabilities(capabilityData);
        setRecords(researchData);
        setProviders(providerData.providers);
        if (providerData.providers.some((item) => item.id === 'gemini' && item.configured && item.capabilities.includes('structured_text'))) {
          setProvider('gemini');
        } else {
          const local = providerData.providers.find((item) => item.id === 'ollama' && item.configured && item.capabilities.includes('structured_text'));
          if (local) setProvider('ollama');
          else {
            const first = providerData.providers.find((item) => item.configured && item.capabilities.includes('structured_text'));
            if (first) setProvider(first.id);
          }
        }
      })
      .catch((reason: unknown) => { if (active) setError((reason as Error).message); });
    return () => { active = false; controllerRef.current?.abort(); };
  }, []);

  useEffect(() => {
    setEditing(selected?.proposal ? structuredClone(selected.proposal) : null);
    setSaved(true);
    setError('');
    setConfirmCost(false);
  }, [selectedId, selected?.proposal]);

  function updateRecord(record: ResearchRecord) {
    setRecords((current) => [record, ...current.filter((item) => item.id !== record.id)].slice(0, 50));
    setSelectedId(record.id);
  }

  async function submitSearch(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!confirmSearch) {
      setError('Confirma que autorizas la consulta de Google Search antes de investigar.');
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy('search');
    try {
      const record = await api.searchResearch({ ...form, confirmExternalSearch: true }, crypto.randomUUID(), controller.signal);
      updateRecord(record);
      setConfirmSearch(false);
      onNotice({ kind: 'success', text: 'Investigación guardada con sus fuentes.' });
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError((reason as Error).message);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setBusy('');
    }
  }

  async function createProposal(event?: FormEvent) {
    event?.preventDefault();
    if (!selected) return;
    if (selectedProvider?.mayIncurCost && !confirmCost) {
      setError('Confirma la solicitud al proveedor seleccionado antes de generar la propuesta.');
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy('proposal');
    setError('');
    try {
      updateRecord(await api.generateResearchProposal(
        selected.id,
        { provider, confirmExternalCost: provider === 'ollama' || confirmCost },
        crypto.randomUUID(),
        controller.signal,
      ));
      setSaved(true);
      onNotice({ kind: 'success', text: 'Propuesta guardada como borrador.' });
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError((reason as Error).message);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setBusy('');
    }
  }

  async function regenerate(section: 'hook' | 'narrativeDevelopment' | 'hashtags' | 'sceneVoiceover', sceneOrder?: number) {
    if (!selected || !editing || !selectedProvider) return;
    if (selectedProvider.mayIncurCost && !confirmCost) {
      setError('Confirma la solicitud al proveedor seleccionado antes de regenerar.');
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(`regenerate-${section}-${sceneOrder || ''}`);
    setError('');
    try {
      const record = await api.regenerateResearchSection(selected.id, {
        section, provider, confirmExternalCost: provider === 'ollama' || confirmCost, sceneOrder,
      }, crypto.randomUUID(), controller.signal);
      updateRecord(record);
      setSaved(true);
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError((reason as Error).message);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setBusy('');
    }
  }

  async function saveProposal() {
    if (!selected || !editing) return;
    setBusy('save');
    setError('');
    try {
      updateRecord(await api.saveResearchProposal(selected.id, editing));
      setSaved(true);
      onNotice({ kind: 'success', text: 'Cambios de la propuesta guardados.' });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function approve() {
    if (!selected || hasProposalChanges) return;
    setBusy('approve');
    setError('');
    try {
      updateRecord(await api.approveResearchProposal(selected.id));
      onNotice({ kind: 'success', text: 'Propuesta aprobada para Media Studio.' });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function sendToMedia() {
    if (!selected) return;
    setBusy('media');
    setError('');
    try {
      const result = await api.sendResearchToMedia(selected.id);
      updateRecord(result.research);
      navigate(`/media-studio?postId=${encodeURIComponent(result.post.id)}`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  function cancel() {
    controllerRef.current?.abort();
    setBusy('');
  }

  return (
    <div className="research-studio">
      <div className="page-heading">
        <div><div className="eyebrow">INVESTIGACIÓN CON FUENTES</div><h1>Tendencias e ideas</h1>
          <p>Consulta fuentes web actuales, contrasta hallazgos y convierte la investigación en un borrador editable.</p></div>
      </div>
      {error && <div className="research-error" role="alert"><AlertCircle size={16} />{error}<button aria-label="Cerrar error" onClick={() => setError('')}><X size={14} /></button></div>}
      <div className="research-grid">
        <section className="panel research-search-panel">
          <div className="panel-heading"><div><h2>Investigar un tema</h2><p>Gemini consulta Google Search; las fuentes se guardan con la fecha de consulta.</p></div><Search className="muted-icon" size={17} /></div>
          {!capabilities?.configured ? <div className="notice-card"><AlertCircle size={17} /><div><strong>Búsqueda no disponible</strong><p>{capabilities?.reason || 'Comprobando configuración de Gemini…'} No se mostrarán resultados ficticios.</p></div></div>
            : <p className="research-cost-note">Hay credenciales y modelo configurados; el acceso real, la cuota y la compatibilidad de Google Search solo se conocen al realizar una búsqueda autorizada.</p>}
          <form className="research-form" onSubmit={submitSearch}>
            <label>Tema o nicho<input required minLength={2} maxLength={80} value={form.niche} onChange={(event) => setForm({ ...form, niche: event.target.value })} placeholder="Ej. ciencia del sueño, cocina económica" /></label>
            <label>Audiencia<input required value={form.audience} onChange={(event) => setForm({ ...form, audience: event.target.value })} /></label>
            <div className="research-form-row">
              <label>Mercado<input required value={form.market} onChange={(event) => setForm({ ...form, market: event.target.value })} /></label>
              <label>Idioma<input required value={form.language} onChange={(event) => setForm({ ...form, language: event.target.value })} /></label>
            </div>
            <div className="research-form-row">
              <label>Objetivo<input required value={form.goal} onChange={(event) => setForm({ ...form, goal: event.target.value })} /></label>
              <label>Formato<input required value={form.format} onChange={(event) => setForm({ ...form, format: event.target.value })} /></label>
            </div>
            <label>Duración aproximada
              <select value={form.durationSeconds} onChange={(event) => setForm({ ...form, durationSeconds: Number(event.target.value) })}>
                {[15, 30, 45, 60, 90, 120, 180].map((seconds) => <option key={seconds} value={seconds}>{seconds} segundos</option>)}
              </select>
            </label>
            <label className="research-consent"><input type="checkbox" checked={confirmSearch} onChange={(event) => setConfirmSearch(event.target.checked)} />
              <span>Autorizo enviar el tema a Gemini y usar Google Search. Puede consumir cuota o generar cargos según mi cuenta.</span>
            </label>
            <button className="button primary" type="submit" disabled={Boolean(busy) || !capabilities?.configured || !confirmSearch}>
              {busy === 'search' ? <><LoaderCircle className="spin" size={15} /> Buscando fuentes…</> : <><Search size={15} /> Investigar con fuentes</>}
            </button>
            {busy === 'search' && <button className="button secondary" type="button" onClick={cancel}>Cancelar búsqueda</button>}
            <p className="research-cost-note">No se consultan métricas internas de TikTok. La popularidad viral no se confirma sin datos específicos.</p>
          </form>
          <div className="research-history">
            <h3>Investigaciones guardadas</h3>
            {records.length === 0 ? <p className="research-empty">Tus investigaciones aparecerán aquí.</p> : records.map((record) =>
              <button key={record.id} className={`research-history-item${record.id === selectedId ? ' active' : ''}`} onClick={() => setSelectedId(record.id)}>
                <span>{record.request.niche}</span><small>{record.status === 'completed' ? `${record.result?.sources.length || 0} fuentes · ` : `${record.status} · `}{new Date(record.createdAt).toLocaleString()}</small>
              </button>,
            )}
          </div>
        </section>
        <section className="research-results">
          {!selected ? <div className="panel placeholder-panel"><div className="welcome-icon"><Sparkles size={19} /></div><h2>Investigación verificable, no tendencias inventadas</h2><p>Define un tema y autoriza una búsqueda para consultar fuentes reales. Los resultados y borradores se guardan localmente.</p></div> : (
            <>
              {selected.status === 'pending' && <div className="panel research-state"><LoaderCircle className="spin" size={18} /> Investigación en curso…</div>}
              {selected.status === 'failed' && <div className="panel research-state"><AlertCircle size={18} /> La investigación no se completó ({selected.errorCode || 'error'}). Puedes iniciar una nueva búsqueda explícitamente.</div>}
              {selected.status === 'cancelled' && <div className="panel research-state">Búsqueda cancelada; no se guardaron resultados parciales.</div>}
              {selected.result && <>
                <section className="panel research-result-panel">
                  <div className="panel-heading"><div><h2>{selected.request.niche}</h2><p>Consultado {new Date(selected.result.sources[0]?.consultedAt || selected.createdAt).toLocaleString()} · {selected.result.sources.length} fuentes citadas por Google Search</p></div><span className="status-badge">Búsqueda web</span></div>
                  <div className="research-caveat">Estas citas proceden de Google Search y no equivalen a una verificación editorial independiente. Las fechas de publicación solo aparecen cuando la fuente las proporciona.</div>
                  <p className="research-summary">{selected.result.summary}</p>
                  <div className="research-findings"><h3>Hallazgos y enfoques</h3>
                    {selected.result.findings.map((finding, index) => <article className="research-finding" key={`${index}-${finding.statement}`}>
                      <span className={`evidence-tag ${finding.evidenceLevel}`}>{evidenceLabels[finding.evidenceLevel]}</span><p>{finding.statement}</p>
                      {finding.sourceIds.length > 0 && <div className="finding-sources">{finding.sourceIds.map((id) => {
                        const source = selected.result?.sources.find((item) => item.id === id);
                        return source ? <a key={id} href={source.url} target="_blank" rel="noreferrer">{source.sourceName}<ExternalLink size={11} /></a> : null;
                      })}</div>}
                    </article>)}
                    {selected.result.angles.map((angle, index) => <article className="research-angle" key={`${index}-${angle.title}`}><strong>{angle.title}</strong><p>Hook sugerido: “{angle.hook}”</p><small>{angle.rationale} · Sugerencia creativa, no tendencia medida.</small></article>)}
                  </div>
                  <div className="research-sources"><h3>Fuentes recuperadas</h3>{selected.result.sources.map((source) => <article key={source.id}>
                    <a href={source.url} target="_blank" rel="noreferrer">{source.title}<ExternalLink size={12} /></a>
                    <small>{source.sourceName} · Publicación: {source.publishedAt ? new Date(source.publishedAt).toLocaleDateString() : 'no indicada por la fuente'} · Consultada: {new Date(source.consultedAt).toLocaleString()}</small>
                    {source.excerpt && <p><strong>Fragmento de respuesta asociado por Gemini:</strong> {source.excerpt}</p>}
                  </article>)}</div>
                  <div className="research-popularity"><strong>Popularidad / competencia:</strong> no medida. No se consultaron analíticas de TikTok; los ángulos son sugerencias creativas.</div>
                  {!selected.proposal && <div className="proposal-create">
                    <div className="panel-heading"><div><h2>Crear propuesta de contenido</h2><p>La propuesta será un borrador; no se publica ni modifica proyectos.</p></div></div>
                    <div className="research-form-row"><label>Proveedor de texto
                      <select value={provider} onChange={(event) => setProvider(event.target.value as AiProviderId)}>
                        {usableProviders.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model || 'modelo configurado'}{item.id === 'ollama' ? ' · local' : ' · puede tener costo'}</option>)}
                      </select>
                    </label></div>
                    {selectedProvider?.mayIncurCost && <label className="research-consent"><input type="checkbox" checked={confirmCost} onChange={(event) => setConfirmCost(event.target.checked)} /><span>Autorizo una solicitud de generación a {selectedProvider.name}; puede consumir cuota o generar cargos.</span></label>}
                    {usableProviders.length === 0 && <p className="research-empty">No hay proveedores de texto configurados. Conecta un proveedor compatible en Integraciones.</p>}
                    <button className="button primary" disabled={Boolean(busy) || usableProviders.length === 0 || Boolean(selectedProvider?.mayIncurCost && !confirmCost)} onClick={() => void createProposal()}>
                      {busy === 'proposal' ? <><LoaderCircle className="spin" size={15} /> Generando…</> : <><Sparkles size={15} /> Crear borrador</>}
                    </button>
                    {busy === 'proposal' && <button className="button secondary" onClick={cancel}>Cancelar generación</button>}
                  </div>}
                </section>
                {editing && selected.proposal && <ProposalEditor
                  proposal={editing}
                  status={selected.proposalStatus}
                  busy={busy}
                  provider={provider}
                  providers={usableProviders}
                  selectedProvider={selectedProvider}
                  confirmCost={confirmCost}
                  hasChanges={hasProposalChanges}
                  saved={saved}
                  onProviderChange={(next) => { setProvider(next); setConfirmCost(false); }}
                  onConfirmCostChange={setConfirmCost}
                  onChange={(next) => { setEditing(next); setSaved(false); }}
                  onSave={() => void saveProposal()}
                  onRegenerate={regenerate}
                  onCancel={cancel}
                  onApprove={() => void approve()}
                  onSend={() => void sendToMedia()}
                />}
              </>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function ProposalEditor({
  proposal, status, busy, provider, providers, selectedProvider, confirmCost, hasChanges, saved,
  onProviderChange, onConfirmCostChange, onChange, onSave, onRegenerate, onCancel, onApprove, onSend,
}: {
  proposal: ResearchProposal;
  status: ResearchRecord['proposalStatus'];
  busy: string;
  provider: AiProviderId;
  providers: AiProvider[];
  selectedProvider?: AiProvider;
  confirmCost: boolean;
  hasChanges: boolean;
  saved: boolean;
  onProviderChange: (provider: AiProviderId) => void;
  onConfirmCostChange: (value: boolean) => void;
  onChange: (proposal: ResearchProposal) => void;
  onSave: () => void;
  onRegenerate: (section: 'hook' | 'narrativeDevelopment' | 'hashtags' | 'sceneVoiceover', sceneOrder?: number) => Promise<void>;
  onCancel: () => void;
  onApprove: () => void;
  onSend: () => void;
}) {
  const editable = status === 'draft';
  return <section className="panel research-proposal">
    <div className="panel-heading"><div><h2>Propuesta de TikTok</h2><p>Borrador editable · {proposal.durationSeconds} s · proveedor: {provider}</p></div><span className={`status-badge ${status === 'approved' ? 'approved' : status === 'sent_to_media' ? 'completed' : 'draft'}`}>{status === 'sent_to_media' ? 'En Media Studio' : status === 'approved' ? 'Aprobada' : 'Borrador'}</span></div>
    <label>Título<input disabled={!editable} value={proposal.title} onChange={(event) => onChange({ ...proposal, title: event.target.value })} /></label>
    <label>Idea central<textarea disabled={!editable} rows={2} value={proposal.centralIdea} onChange={(event) => onChange({ ...proposal, centralIdea: event.target.value })} /></label>
    <label>Audiencia objetivo<input disabled={!editable} value={proposal.targetAudience} onChange={(event) => onChange({ ...proposal, targetAudience: event.target.value })} /></label>
    <label>Hook inicial<textarea disabled={!editable} rows={2} value={proposal.hook} onChange={(event) => onChange({ ...proposal, hook: event.target.value })} /></label>
    {editable && <button className="button secondary small-button" disabled={Boolean(busy) || (provider !== 'ollama' && !confirmCost)} onClick={() => void onRegenerate('hook')}>{busy === 'regenerate-hook-' ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />} Regenerar hook</button>}
    <label>Desarrollo narrativo<textarea disabled={!editable} rows={4} value={proposal.narrativeDevelopment} onChange={(event) => onChange({ ...proposal, narrativeDevelopment: event.target.value })} /></label>
    {editable && <button className="button secondary small-button" disabled={Boolean(busy) || (provider !== 'ollama' && !confirmCost)} onClick={() => void onRegenerate('narrativeDevelopment')}>{busy === 'regenerate-narrativeDevelopment-' ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />} Regenerar desarrollo</button>}
    <div className="proposal-scenes"><h3>Guion por escenas</h3>{proposal.scenes.map((scene, index) => <article key={scene.order}>
      <div className="scene-title"><strong>Escena {scene.order}</strong><span>{scene.durationSeconds} s</span></div>
      <label>Voz en off<textarea disabled={!editable} rows={3} value={scene.voiceover} onChange={(event) => onChange({
        ...proposal, scenes: proposal.scenes.map((item, itemIndex) => itemIndex === index ? { ...item, voiceover: event.target.value } : item),
      })} /></label>
      <label>Propuesta visual<textarea disabled={!editable} rows={2} value={scene.visualProposal} onChange={(event) => onChange({
        ...proposal, scenes: proposal.scenes.map((item, itemIndex) => itemIndex === index ? { ...item, visualProposal: event.target.value } : item),
      })} /></label>
      {editable && <button className="button secondary small-button" disabled={Boolean(busy) || (provider !== 'ollama' && !confirmCost)} onClick={() => void onRegenerate('sceneVoiceover', scene.order)}>
        {busy === `regenerate-sceneVoiceover-${scene.order}` ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />} Regenerar solo voz
      </button>}
    </article>)}</div>
    <label>Descripción<textarea disabled={!editable} rows={2} value={proposal.description} onChange={(event) => onChange({ ...proposal, description: event.target.value })} /></label>
    <label>Hashtags<input disabled={!editable} value={proposal.hashtags.join(' ')} onChange={(event) => onChange({ ...proposal, hashtags: event.target.value.split(/\s+/).filter(Boolean) })} /></label>
    {editable && <button className="button secondary small-button" disabled={Boolean(busy) || (provider !== 'ollama' && !confirmCost)} onClick={() => void onRegenerate('hashtags')}>{busy === 'regenerate-hashtags-' ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />} Regenerar hashtags</button>}
    <div className="proposal-claims"><h3>Afirmaciones y respaldo</h3>{proposal.claims.map((claim, index) => <p key={`${index}-${claim.statement}`}><span className={`evidence-tag ${claim.evidenceLevel}`}>{evidenceLabels[claim.evidenceLevel]}</span> {claim.statement}</p>)}</div>
    {editable && <div className="research-proposal-provider">
      <label>Proveedor para regenerar
        <select value={provider} onChange={(event) => onProviderChange(event.target.value as AiProviderId)}>
          {providers.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model || 'modelo configurado'}{item.id === 'ollama' ? ' · local' : ' · puede tener costo'}</option>)}
        </select>
      </label>
      {selectedProvider?.mayIncurCost && <label className="research-consent"><input type="checkbox" checked={confirmCost} onChange={(event) => onConfirmCostChange(event.target.checked)} /><span>Autorizo cada solicitud alojada de regeneración; puede consumir cuota o generar cargos.</span></label>}
      {busy.startsWith('regenerate-') && <button className="button secondary small-button" onClick={onCancel}>Cancelar regeneración</button>}
    </div>}
    <div className="research-proposal-actions">
      {editable && <button className="button secondary" disabled={Boolean(busy) || !hasChanges} onClick={onSave}><Check size={14} />{busy === 'save' ? 'Guardando…' : 'Guardar borrador'}</button>}
      {editable && <button className="button primary" disabled={Boolean(busy) || hasChanges || !saved} onClick={onApprove}><Check size={14} />{busy === 'approve' ? 'Aprobando…' : 'Aprobar propuesta'}</button>}
      {editable && hasChanges && <span className="research-save-warning">Guarda los cambios antes de aprobar.</span>}
      {status === 'approved' && <button className="button primary" disabled={Boolean(busy)} onClick={onSend}>{busy === 'media' ? <LoaderCircle className="spin" size={14} /> : <ArrowRight size={14} />} Enviar borrador a Media Studio</button>}
      {status === 'sent_to_media' && <><p className="research-save-warning">Propuesta vinculada a un borrador. El proyecto de Media Studio se crea mediante el flujo existente.</p><button className="button secondary" disabled={Boolean(busy)} onClick={onSend}><ArrowRight size={14} /> Abrir en Media Studio</button></>}
    </div>
  </section>;
}
