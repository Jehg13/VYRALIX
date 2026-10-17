import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { AlertCircle, AudioLines, ImagePlus, LoaderCircle, RefreshCw, Save, Sparkles, Upload, Video } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, type ImageGenerationCapabilities, type ImageGenerationPreview, type MediaAsset } from './api';

const kindLabels: Record<MediaAsset['kind'], string> = {
  image: 'Imagen',
  video: 'Video',
  audio: 'Audio',
};

function fileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MediaLibrary({ onNotice }: {
  onNotice: (notice: { kind: 'success' | 'error'; text: string } | null) => void;
}) {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [filter, setFilter] = useState<'all' | MediaAsset['kind']>('all');
  const [search, setSearch] = useState('');
  const [provenance, setProvenance] = useState('Importado localmente');
  const [license, setLicense] = useState('Sin verificar');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [failedPreviews, setFailedPreviews] = useState<string[]>([]);
  const [imageCapabilities, setImageCapabilities] = useState<ImageGenerationCapabilities | null>(null);
  const [imagePrompt, setImagePrompt] = useState('');
  const [imageModel, setImageModel] = useState('');
  const [imagePreview, setImagePreview] = useState<ImageGenerationPreview | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageSaving, setImageSaving] = useState(false);
  const [imageCostConfirmed, setImageCostConfirmed] = useState(false);
  const [imageError, setImageError] = useState('');
  const imageAbort = useRef<AbortController | null>(null);
  const imageRequestId = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function refresh() {
    setLoading(true);
    try {
      setAssets(await api.mediaAssets());
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    void api.mediaImageGenerationCapabilities().then((capabilities) => {
      setImageCapabilities(capabilities);
      setImageModel(capabilities.model || capabilities.availableModels[0]?.id || '');
      setImageError('');
    }).catch((reason) => setImageError((reason as Error).message));
  }, []);

  const visibleAssets = useMemo(() => assets
    .filter((asset) => filter === 'all' || asset.kind === filter)
    .filter((asset) => asset.originalName.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())),
  [assets, filter, search]);

  async function importFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    setBusy(true);
    setError('');
    let imported = 0;
    let duplicates = 0;
    try {
      for (const file of files) {
        const result = await api.uploadMediaAsset(file, provenance, license);
        if (result.duplicate) duplicates += 1;
        else imported += 1;
      }
      await refresh();
      onNotice({ kind: 'success', text: `${imported} recurso(s) importado(s); ${duplicates} duplicado(s) existente(s).` });
    } catch (reason) {
      setError((reason as Error).message);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function generateImage() {
    if (!imageCapabilities?.enabled || !imageModel || imagePrompt.trim().length < 5 || !imageCostConfirmed || imageBusy) return;
    const requestId = imageRequestId.current || crypto.randomUUID();
    imageRequestId.current = requestId;
    const controller = new AbortController();
    imageAbort.current = controller;
    setImageBusy(true);
    setImageError('');
    try {
      setImagePreview(await api.generateMediaImage({
        provider: 'gemini',
        model: imageModel,
        prompt: imagePrompt.trim(),
        confirmCost: true,
      }, requestId, controller.signal));
      imageRequestId.current = null;
    } catch (reason) {
      setImageError((reason as Error).message);
    } finally {
      imageAbort.current = null;
      setImageBusy(false);
    }
  }

  async function saveGeneratedImage() {
    if (!imagePreview || imageSaving) return;
    setImageSaving(true);
    setImageError('');
    try {
      const result = await api.saveGeneratedMediaImage(imagePreview.id);
      await refresh();
      onNotice({ kind: 'success', text: result.duplicate ? 'La imagen ya existía en la biblioteca.' : 'Imagen guardada en la biblioteca local.' });
    } catch (reason) {
      setImageError((reason as Error).message);
    } finally {
      setImageSaving(false);
    }
  }

  return <>
    <div className="page-heading">
      <div><div className="eyebrow">RECURSOS LOCALES</div><h1>Biblioteca multimedia</h1><p>Importa y reutiliza imágenes, clips y audio almacenados localmente.</p></div>
      <div className="heading-actions">
        <button className="button secondary" onClick={() => void refresh()} disabled={loading || busy}>
          <RefreshCw size={15} className={loading ? 'spin' : ''} /> Actualizar
        </button>
        <button className="button primary" type="button" onClick={() => fileInput.current?.click()} disabled={busy}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}
          {busy ? 'Importando…' : 'Importar archivos'}
        </button>
        <input ref={fileInput} id="media-library-upload" className="media-library-file-input" type="file"
          accept=".png,.jpg,.jpeg,.webp,.mp4,.mov,.webm,.mp3,.wav,.m4a,.ogg" multiple
          aria-hidden="true" tabIndex={-1} disabled={busy} onChange={(event) => void importFiles(event)} />
      </div>
    </div>
    <div className="ai-privacy-note"><span><AlertCircle size={16} /></span><div>
      <strong>La generación de imágenes es opcional y requiere configuración explícita.</strong>
      <p>Groq documenta análisis visual para modelos multimodales específicos, pero eso no equivale a generar imágenes. Gemini solo generará imágenes con un modelo dedicado configurado; cada solicitud envía el prompt a Google y puede consumir cuota o generar costos. Los archivos se guardan solo cuando eliges “Guardar en biblioteca”.</p>
    </div></div>
    <section className="panel image-generation-panel">
      <div className="image-generation-heading"><div><div className="eyebrow">GEMINI · IMAGEN</div><h2>Generar una imagen</h2><p>Previsualiza el resultado; no se incorpora a tus recursos hasta guardarlo explícitamente.</p></div>
        <Sparkles size={20} aria-hidden="true" />
      </div>
      {imageError && <div className="error-banner"><AlertCircle size={17} /><span>{imageError}</span><button onClick={() => setImageError('')}>Cerrar</button></div>}
      {!imageCapabilities?.enabled && <div className="image-generation-setup">
        <strong>Generación desactivada hasta configurar un modelo dedicado.</strong>
        <span>Define <code>GEMINI_IMAGE_MODEL=gemini-nano-banana-2.1</code> junto con tu clave Gemini existente y reinicia la API. También puedes escoger otro modelo de imagen documentado por Google.</span>
        {imageCapabilities?.missing.map((item) => <small key={item}>Falta o no es compatible: {item}</small>)}
      </div>}
      <div className="image-generation-form">
        <label>Proveedor<select value="gemini" disabled aria-label="Proveedor de generación de imagen"><option value="gemini">Gemini · Google</option></select></label>
        <label>Modelo de imagen<select value={imageModel} onChange={(event) => {
          setImageModel(event.target.value);
          imageRequestId.current = null;
          setImagePreview(null);
        }} disabled={!imageCapabilities?.enabled || imageBusy}>
          {imageCapabilities?.availableModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select></label>
        <label className="image-generation-prompt">Descripción<textarea rows={3} maxLength={2000} value={imagePrompt} onChange={(event) => {
          setImagePrompt(event.target.value);
          imageRequestId.current = null;
          setImagePreview(null);
        }} disabled={imageBusy} placeholder="Describe el sujeto, estilo, encuadre, iluminación y composición…" /></label>
        <label className="image-generation-consent"><input type="checkbox" checked={imageCostConfirmed} onChange={(event) => setImageCostConfirmed(event.target.checked)} />
          Confirmo que esta solicitud y sus reintentos enviarán el prompt a Google y podrían consumir cuota o generar costos según mi cuenta.
        </label>
        <div className="image-generation-actions">
          <button className="button primary" onClick={() => void generateImage()} disabled={!imageCapabilities?.enabled || imagePrompt.trim().length < 5 || !imageCostConfirmed || imageBusy || imageSaving}>
            {imageBusy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
            {imageBusy ? 'Generando…' : imagePreview ? 'Regenerar imagen' : 'Generar imagen'}
          </button>
          {imageBusy && <button className="button secondary" onClick={() => imageAbort.current?.abort()}><span>Cancelar</span></button>}
          {imagePreview && <button className="button secondary" onClick={() => void saveGeneratedImage()} disabled={imageBusy || imageSaving}>
            {imageSaving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}{imageSaving ? 'Guardando…' : 'Guardar en biblioteca'}
          </button>}
        </div>
        {imageBusy && <p className="image-generation-status" role="status">Solicitud enviada a Gemini; espera la respuesta del modelo.</p>}
      </div>
      {imagePreview && <div className="image-generation-preview">
        <img src={api.generatedMediaImageUrl(imagePreview.id)} alt="Previsualización de la imagen generada" />
        <div><strong>Previsualización · {imagePreview.model}</strong><span>Temporal en memoria del servidor; guarda la imagen para conservarla.</span></div>
      </div>}
    </section>
    {error && <div className="error-banner"><AlertCircle size={17} /><span>{error}</span><button onClick={() => setError('')}>Cerrar</button><button onClick={() => void refresh()}>Reintentar</button></div>}
    <section className="panel media-library-panel">
      <div className="media-library-controls">
        <label>Buscar por nombre<input aria-label="Buscar recursos multimedia" placeholder="Nombre de archivo…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label>Tipo<select aria-label="Filtrar recursos multimedia" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
          <option value="all">Todos los recursos</option><option value="image">Imágenes</option><option value="video">Videos</option><option value="audio">Audio</option>
        </select></label>
        <span>{visibleAssets.length} de {assets.length} recurso(s)</span>
      </div>
      <div className="media-provenance-fields">
        <label>Procedencia declarada<input maxLength={300} value={provenance} onChange={(event) => setProvenance(event.target.value)} /></label>
        <label>Licencia / atribución<input maxLength={300} value={license} onChange={(event) => setLicense(event.target.value)} /></label>
      </div>
      {loading && !assets.length ? <div className="loading-state compact"><LoaderCircle size={17} className="spin" />Cargando biblioteca local…</div>
        : visibleAssets.length ? <div className="media-library-grid">{visibleAssets.map((asset) => {
          const previewFailed = asset.missing || failedPreviews.includes(asset.id);
          return <article className="media-library-card" key={asset.id}>
            <div className="media-library-preview">
              {previewFailed ? <AlertCircle size={23} />
                : asset.kind === 'image' ? <img src={api.mediaAssetUrl(asset.id)} alt={asset.originalName} loading="lazy" onError={() => setFailedPreviews((current) => current.includes(asset.id) ? current : [...current, asset.id])} />
                  : asset.kind === 'video' ? <video src={api.mediaAssetUrl(asset.id)} controls preload="metadata" onError={() => setFailedPreviews((current) => current.includes(asset.id) ? current : [...current, asset.id])} />
                    : <audio src={api.mediaAssetUrl(asset.id)} controls preload="none" aria-label={`Reproducir ${asset.originalName}`} onError={() => setFailedPreviews((current) => current.includes(asset.id) ? current : [...current, asset.id])} />}
              <span>{kindLabels[asset.kind]}{previewFailed ? ' · no disponible' : ''}</span>
            </div>
            <div className="media-library-card-info">
              <strong title={asset.originalName}>{asset.originalName}</strong>
              <small>{fileSize(asset.sizeBytes)} · {asset.mimeType}{asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}{asset.durationSeconds ? ` · ${asset.durationSeconds.toFixed(1)} s` : ''}</small>
              <small>{asset.license} · {asset.provenance}</small>
            </div>
            <Link className="text-link" to="/media-studio">Abrir Media Studio para asignar</Link>
          </article>;
        })}</div>
          : <div className="media-empty compact">
            {filter === 'image' ? <ImagePlus size={20} /> : filter === 'video' ? <Video size={20} /> : filter === 'audio' ? <AudioLines size={20} /> : <Upload size={20} />}
            <strong>{assets.length ? 'No hay recursos que coincidan' : 'Biblioteca vacía'}</strong>
            <span>{assets.length ? 'Prueba otro nombre o filtro.' : 'Importa archivos locales autorizados para verlos y reutilizarlos en tus escenas.'}</span>
          </div>}
      <p className="media-license-note">Los recursos se guardan junto a la base local. En Media Studio puedes asignar imágenes o clips a escenas y la selección queda asociada al proyecto.</p>
    </section>
  </>;
}
