import { useEffect, useState } from 'react';
import { AlertCircle, ArrowDown, ArrowUp, Check, LoaderCircle, RefreshCw, Save } from 'lucide-react';
import { api, formatDate, type AiProvider, type AiProviderId } from './api';

const names: Record<AiProviderId, string> = { gemini: 'Google Gemini', groq: 'Groq', ollama: 'Ollama local' };
const statusText: Record<AiProvider['availability'], string> = {
  unknown: 'Disponibilidad desconocida',
  available: 'Disponible',
  unavailable: 'No disponible',
  model_invalid: 'Modelo no encontrado o no habilitado',
  error: 'Error de comprobación',
};

export default function AiProviders() {
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [priority, setPriority] = useState<AiProviderId[]>(['gemini', 'groq', 'ollama']);
  const [savedPriority, setSavedPriority] = useState<AiProviderId[]>(['gemini', 'groq', 'ollama']);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      const result = await api.aiProviders();
      setProviders(result.providers);
      setPriority(result.priority);
      setSavedPriority(result.priority);
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function check() {
    setChecking(true);
    setMessage('');
    try {
      const result = await api.checkAiProviders();
      setProviders(result.providers);
      setMessage('Comprobación terminada. Los modelos listados proceden de las respuestas actuales del proveedor.');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function save() {
    setSaving(true);
    setMessage('');
    try {
      const result = await api.setAiPriority(priority);
      setSavedPriority(result.priority);
      setPriority(result.priority);
      setMessage('Prioridad guardada.');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function move(provider: AiProviderId, direction: -1 | 1) {
    setPriority((current) => {
      const next = [...current];
      const index = next.indexOf(provider);
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  return <section className="panel ai-settings-panel">
    <div className="panel-heading"><div><div className="eyebrow">PROVEEDORES IA</div><h2>Configuración de proveedores</h2><p>Las claves nunca se envían a la interfaz; configura credenciales y modelos en el archivo .env y reinicia la API.</p></div></div>
    {error && <div className="error-banner"><AlertCircle size={16} /><span>{error}</span><button onClick={() => setError('')}>Cerrar</button></div>}
    {message && <div className="ai-success-note"><Check size={14} />{message}</div>}
    <div className="ai-provider-actions"><button className="button secondary" disabled={checking || loading} onClick={() => void check()}>{checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{checking ? 'Comprobando...' : 'Comprobar disponibilidad'}</button><button className="button primary" disabled={saving || loading || priority.every((id, index) => id === savedPriority[index])} onClick={() => void save()}>{saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}{saving ? 'Guardando...' : 'Guardar prioridad'}</button></div>
    {loading ? <div className="loading-state compact"><LoaderCircle size={17} className="spin" />Cargando configuración...</div> : <div className="ai-provider-list">{priority.map((id, index) => {
      const provider = providers.find((item) => item.id === id);
      if (!provider) return null;
      return <article className="ai-provider-card" key={id}>
        <div className="provider-priority"><span>{index + 1}</span><div><button className="icon-button" title="Subir prioridad" aria-label={`Subir ${names[id]}`} disabled={index === 0 || saving} onClick={() => move(id, -1)}><ArrowUp size={15} /></button><button className="icon-button" title="Bajar prioridad" aria-label={`Bajar ${names[id]}`} disabled={index === priority.length - 1 || saving} onClick={() => move(id, 1)}><ArrowDown size={15} /></button></div></div>
        <div className={`provider-avatar large ${id}`}>{names[id].slice(0, 1)}</div>
        <div className="ai-provider-details">
          <div className="provider-title"><strong>{names[id]}</strong><span className={`provider-state-tag ${provider.configured ? provider.availability : 'not-configured'}`}>{provider.configured ? statusText[provider.availability] : 'No configurado'}</span></div>
          <p>Modelo configurado: <b>{provider.model || 'No definido'}</b></p>
          {provider.missing.length > 0 && <p>Variables pendientes: <code>{provider.missing.join(', ')}</code></p>}
          <p>Capacidades: {provider.capabilities.map((capability) => capability.replaceAll('_', ' ')).join(', ')}</p>
          <p>Última comprobación: {provider.checkedAt ? formatDate(provider.checkedAt, { hour: '2-digit', minute: '2-digit' }) : 'Aún no comprobado'}</p>
          <p>Última ejecución: {provider.lastRunAt ? formatDate(provider.lastRunAt, { hour: '2-digit', minute: '2-digit' }) : 'Sin ejecuciones'}</p>
          <p>Fallback automático: {provider.autoFallbackAllowed ? 'permitido por configuración' : 'desactivado'} · {provider.mayIncurCost ? 'puede generar cargos según el plan; tarifa desconocida' : 'ejecución local'}</p>
          <p>Último error: {provider.lastError || 'Ninguno registrado'} · Costos: desconocidos</p>
          {provider.availableModels.length > 0 && <details className="available-models"><summary>Modelos que el proveedor anuncia ({provider.availableModels.length})</summary><div>{provider.availableModels.join(' · ')}</div></details>}
        </div>
      </article>;
    })}</div>}
    <div className="ai-env-help"><strong>Variables locales</strong><code>GEMINI_API_KEY · GEMINI_MODEL · GROQ_API_KEY · GROQ_MODEL · OLLAMA_BASE_URL · OLLAMA_MODEL · GEMINI_AUTO_FALLBACK · GROQ_AUTO_FALLBACK</code><span>El fallback alojado está desactivado por defecto; actívalo explícitamente en .env. La tarifa y cuota de tu cuenta son desconocidas para VYRALIX. La generación envía el texto al proveedor seleccionado. Comprueba los términos de privacidad y tratamiento de datos aplicables a tu plan antes de enviar material sensible.</span></div>
  </section>;
}
