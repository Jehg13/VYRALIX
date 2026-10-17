import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity, AlertCircle, ArrowDownToLine, ArrowLeft, ArrowRight, Bell, CalendarDays, Clapperboard,
  Check, ChevronDown, CircleHelp, Clock3, FileText, Filter, FolderOpen,
  Gauge, Layers3, Lightbulb, LoaderCircle, Plus, Search, Settings2, Sparkles,
  TrendingUp, X,
} from 'lucide-react';
import { api, formatDate, localDateTime, statusLabels, toIsoDateTime, type DashboardData, type Job, type Post, type PostInput, type PostStatus } from './api';
import AiGenerator from './AiGenerator';
import AiProviders from './AiProviders';
import AutomationStudio from './AutomationStudio';
import MediaLibrary from './MediaLibrary';
import MediaStudio from './MediaStudio';
import ResearchStudio from './ResearchStudio';

type Notice = { kind: 'success' | 'error'; text: string } | null;
const statuses = Object.keys(statusLabels) as PostStatus[];
const allowedTransitions: Record<PostStatus, PostStatus[]> = {
  idea: ['draft', 'archived'],
  draft: ['idea', 'pending_review', 'archived'],
  pending_review: ['draft', 'approved', 'archived'],
  approved: ['draft', 'scheduled', 'archived'],
  scheduled: ['approved', 'archived'],
  publishing: ['error', 'published'],
  published: ['archived'],
  error: ['draft', 'approved', 'scheduled', 'archived'],
  archived: ['draft'],
};
const navGroups = [
  { title: 'ESPACIO DE TRABAJO', items: [
    { to: '/', label: 'Dashboard', icon: Gauge },
    { to: '/contenido', label: 'Centro de contenido', icon: Layers3 },
    { to: '/generador', label: 'Generador IA', icon: Sparkles },
    { to: '/media-studio', label: 'Media Studio', icon: Clapperboard },
    { to: '/calendario', label: 'Calendario editorial', icon: CalendarDays },
    { to: '/cola', label: 'Cola de publicaciones', icon: ArrowDownToLine },
  ] },
  { title: 'RECURSOS', items: [
    { to: '/biblioteca', label: 'Biblioteca multimedia', icon: FolderOpen },
    { to: '/investigacion', label: 'Tendencias e ideas', icon: Lightbulb },
    { to: '/analitica', label: 'Analítica', icon: TrendingUp },
  ] },
  { title: 'SISTEMA', items: [
    { to: '/integraciones', label: 'Integraciones', icon: Activity },
    { to: '/automatizaciones', label: 'Automatizaciones', icon: Clapperboard },
    { to: '/configuracion', label: 'Configuración', icon: Settings2 },
  ] },
];

const titles: Record<string, string> = {
  '/': 'Dashboard',
  '/contenido': 'Centro de contenido',
  '/generador': 'Generador con IA',
  '/media-studio': 'Media Studio',
  '/calendario': 'Calendario editorial',
  '/cola': 'Cola de publicaciones',
  '/biblioteca': 'Biblioteca multimedia',
  '/investigacion': 'Tendencias e investigación',
  '/analitica': 'Analítica',
  '/integraciones': 'Integraciones',
  '/automatizaciones': 'Automatizaciones',
  '/configuracion': 'Configuración',
};

function App() {
  const [notice, setNotice] = useState<Notice>(null);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const location = useLocation();
  useEffect(() => {
    let mounted = true;
    async function checkApi() {
      try {
        await api.health();
        if (mounted) setApiOnline(true);
      } catch {
        if (mounted) setApiOnline(false);
      }
    }
    void checkApi();
    const interval = window.setInterval(() => void checkApi(), 5000);
    return () => { mounted = false; window.clearInterval(interval); };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" to="/" aria-label="Vyralix, inicio">
          <div className="brand-mark"><img src="/vyralix-logo.png" alt="" /></div>
          <span>VYRALIX<small>CONTENT STUDIO</small></span>
        </Link>
        <div className="workspace-switch"><div className="workspace-avatar">V</div><span>Mi espacio<small>Plan local</small></span><ChevronDown size={15} /></div>
        <nav className="side-nav" aria-label="Navegación principal">
          {navGroups.map((group) => <div className="nav-group" key={group.title}>
            <p className="nav-heading">{group.title}</p>
            {group.items.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              <Icon size={17} strokeWidth={1.8} /><span>{label}</span>
              {to === '/cola' && <span className="nav-dot" />}
            </NavLink>)}
          </div>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-status"><span className="status-pulse" /><span>Servicios locales<small>Conexión protegida</small></span><CircleHelp size={15} /></div>
          <div className="profile"><div className="profile-avatar">V</div><span>Vyralix local<small>Administrador</small></span><MoreDots /></div>
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs"><span>VYRALIX</span><span className="crumb-divider">/</span><strong>{titles[location.pathname] || 'VYRALIX'}</strong></div>
          <div className="top-actions"><div className="api-indicator"><span className={`status-pulse${apiOnline === false ? ' offline' : ''}`} />{apiOnline === false ? 'API desconectada' : apiOnline ? 'API conectada' : 'Conectando...'}</div><span className="top-notification" aria-hidden="true"><Bell size={17} /></span><div className="top-avatar">V</div></div>
        </header>
        <div className="page-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/contenido" element={<ContentPage onNotice={setNotice} />} />
            <Route path="/generador" element={<AiGenerator onNotice={setNotice} />} />
            <Route path="/media-studio" element={<MediaStudio onNotice={setNotice} />} />
            <Route path="/biblioteca" element={<MediaLibrary onNotice={setNotice} />} />
            <Route path="/investigacion" element={<ResearchStudio onNotice={setNotice} />} />
            <Route path="/automatizaciones" element={<AutomationStudio onNotice={setNotice} />} />
            <Route path="/configuracion" element={<PlaceholderPage title="Configuración" />} />
            <Route path="/calendario" element={<CalendarPage onNotice={setNotice} />} />
            <Route path="/cola" element={<QueuePage onNotice={setNotice} />} />
            <Route path="*" element={<PlaceholderPage title={titles[location.pathname] || 'Módulo'} />} />
          </Routes>
          <footer className="app-footer"><span>VYRALIX <b>·</b> Sistema local de contenido</span><span>Zona horaria: {Intl.DateTimeFormat().resolvedOptions().timeZone}</span></footer>
        </div>
      </main>
      {notice && <div className={`toast ${notice.kind}`} role="status"><span>{notice.kind === 'success' ? <Check size={17} /> : <AlertCircle size={17} />}</span>{notice.text}<button aria-label="Cerrar notificación" onClick={() => setNotice(null)}><X size={15} /></button></div>}
    </div>
  );
}

function MoreDots() {
  return <span className="dots-decoration" aria-hidden="true"><i /><i /><i /></span>;
}

function PageHeading({ eyebrow, title, subtitle, actions }: { eyebrow: string; title: string; subtitle: string; actions?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>{actions && <div className="heading-actions">{actions}</div>}</div>;
}

function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  async function refresh() {
    setLoading(true);
    try { setData(await api.dashboard()); setError(''); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  const metrics = useMemo(() => data ? [
    { label: 'Programadas hoy', value: data.today.scheduled, note: 'Publicaciones en calendario', icon: CalendarDays, tone: 'purple' },
    { label: 'Publicadas hoy', value: data.today.published, note: 'Confirmadas localmente', icon: Check, tone: 'blue' },
    { label: 'Por revisar', value: data.posts.pending_review || 0, note: 'Borradores pendientes', icon: FileText, tone: 'yellow' },
    { label: 'Trabajos pendientes', value: data.jobs.pending || 0, note: 'Pruebas locales en cola', icon: Clock3, tone: 'green' },
  ] : [], [data]);
  if (loading && !data) return <LoadingState />;
  return <>
    <PageHeading eyebrow="VISTA GENERAL" title="Tu centro de control" subtitle="Una visión clara de tu operación de contenido, sin métricas inventadas." actions={<button className="button secondary" onClick={() => void refresh()}><Activity size={16} /> Actualizar</button>} />
    {error && <ErrorBanner message={error} retry={() => void refresh()} />}
    <div className="welcome-strip"><div className="welcome-icon"><Sparkles size={20} /></div><div><strong>Hola, creador.</strong><span>Este espacio está listo para organizar tu flujo de contenido.</span></div><span className="welcome-label"><span className="status-pulse" /> MODO LOCAL</span></div>
    <div className="metric-grid">{metrics.map(({ label, value, note, icon: Icon, tone }) => <div className="metric-card" key={label}>
      <div className="metric-top"><span>{label}</span><div className={`metric-icon ${tone}`}><Icon size={17} /></div></div>
      <div className="metric-value">{value}</div><div className="metric-note">{note}</div>
    </div>)}</div>
    <div className="dashboard-grid">
      <section className="panel activity-panel">
        <div className="panel-heading"><div><h2>Actividad de contenido</h2><p>Creaciones registradas en los últimos 7 días</p></div><span className="panel-caption">DATOS REALES</span></div>
        {data?.activity.length ? <ActivityChart activity={data.activity} /> : <EmptyState icon={<Activity size={20} />} title="Aún no hay actividad" text="Cuando crees contenido, su actividad aparecerá aquí." />}
      </section>
      <section className="panel next-panel">
        <div className="panel-heading"><div><h2>Próxima publicación</h2><p>Según tu calendario editorial</p></div><CalendarDays size={17} className="muted-icon" /></div>
        {data?.nextPost ? <div className="next-post"><span className="status-badge scheduled">{statusLabels[data.nextPost.status]}</span><h3>{data.nextPost.title}</h3><p>{data.nextPost.category} · {data.nextPost.platform}</p><div className="next-date"><Clock3 size={14} />{formatDate(data.nextPost.scheduledAt, { hour: '2-digit', minute: '2-digit' })}</div><Link to="/calendario" className="text-link">Abrir calendario <ArrowRight size={14} /></Link></div> : <EmptyState icon={<CalendarDays size={20} />} title="Sin publicaciones próximas" text="Programa contenido para tenerlo a la vista aquí." action={<Link className="text-link" to="/calendario">Ir al calendario <ArrowRight size={14} /></Link>} />}
      </section>
    </div>
    <div className="bottom-grid">
      <section className="panel status-panel"><div className="panel-heading"><div><h2>Estado del contenido</h2><p>Distribución actual por estado</p></div><Link to="/contenido" className="text-link">Ver todo <ArrowRight size={14} /></Link></div>
        {data && Object.entries(data.posts).some(([, count]) => count > 0) ? <div className="status-list">{(['draft', 'pending_review', 'approved', 'scheduled', 'published'] as PostStatus[]).map((status) => <div className="status-row" key={status}><span className={`status-dot ${status}`} />{statusLabels[status]}<strong>{data.posts[status] || 0}</strong></div>)}</div> : <EmptyState title="Tu biblioteca está vacía" text="Crea un borrador para comenzar a construir tu flujo editorial." action={<Link to="/contenido" className="text-link">Crear contenido <ArrowRight size={14} /></Link>} />}
      </section>
      <section className="panel quick-panel"><div className="panel-heading"><div><h2>Acciones rápidas</h2><p>Continúa con tu flujo de trabajo</p></div></div><div className="quick-actions">
        <Link to="/contenido?new=1" className="quick-action"><span className="quick-icon violet"><Plus size={17} /></span><span><strong>Nuevo contenido</strong><small>Crear un borrador manual</small></span><ArrowRight size={15} /></Link>
        <Link to="/calendario" className="quick-action"><span className="quick-icon blue"><CalendarDays size={17} /></span><span><strong>Planificar publicación</strong><small>Organizar tu calendario</small></span><ArrowRight size={15} /></Link>
        <Link to="/cola" className="quick-action"><span className="quick-icon yellow"><ArrowDownToLine size={17} /></span><span><strong>Revisar la cola</strong><small>Pruebas locales, sin publicar</small></span><ArrowRight size={15} /></Link>
      </div></section>
    </div>
  </>;
}

function ActivityChart({ activity }: { activity: DashboardData['activity'] }) {
  const chart = Array.from({ length: 7 }, (_, index) => {
    const day = new Date();
    day.setDate(day.getDate() - (6 - index));
    const dateKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    return { label: new Intl.DateTimeFormat('es-MX', { weekday: 'short' }).format(day).replace('.', ''), count: activity.find((item) => item.day === dateKey)?.count || 0 };
  });
  const max = Math.max(...chart.map((item) => item.count), 1);
  return <div className="chart-wrap"><div className="chart-y-labels"><span>{max}</span><span>{Math.ceil(max / 2)}</span><span>0</span></div><div className="bar-chart">{chart.map((item, index) => <div className="bar-column" key={`${item.label}-${index}`}><div className="bar-track"><div className="bar-fill" style={{ height: `${Math.max(item.count ? (item.count / max) * 100 : 0, 3)}%` }} title={`${item.count} contenidos`} /></div><span>{item.label}</span></div>)}</div></div>;
}

function ContentPage({ onNotice }: { onNotice: (notice: Notice) => void }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Post | null | false>(false);
  const location = useLocation();
  const navigate = useNavigate();
  async function refresh() {
    setLoading(true);
    try { setPosts(await api.posts(search, filter)); setError(''); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, [search, filter]);
  useEffect(() => {
    if (new URLSearchParams(location.search).has('new')) {
      setEditing(null);
      navigate('/contenido', { replace: true });
    }
  }, [location.search, navigate]);
  async function save(input: PostInput) {
    try {
      if (editing) await api.updatePost(editing.id, input);
      else await api.createPost(input);
      setEditing(false);
      await refresh();
      onNotice({ kind: 'success', text: editing ? 'Cambios guardados.' : 'Borrador creado.' });
    } catch (e) { onNotice({ kind: 'error', text: (e as Error).message }); }
  }
  async function remove(post: Post) {
    if (!window.confirm(`¿Eliminar “${post.title}”? Esta acción no se puede deshacer.`)) return;
    try { await api.deletePost(post.id); await refresh(); onNotice({ kind: 'success', text: 'Contenido eliminado.' }); }
    catch (e) { onNotice({ kind: 'error', text: (e as Error).message }); }
  }
  return <>
    <PageHeading eyebrow="TU CONTENIDO" title="Centro de contenido" subtitle="Organiza borradores y publicaciones desde una biblioteca persistente." actions={<button className="button primary" onClick={() => setEditing(null)}><Plus size={17} /> Nuevo contenido</button>} />
    {error && <ErrorBanner message={error} retry={() => void refresh()} />}
    <section className="panel content-panel">
      <div className="content-toolbar"><div className="search-box"><Search size={16} /><input aria-label="Buscar contenido" placeholder="Buscar por título, texto o categoría..." value={search} onChange={(event) => setSearch(event.target.value)} /></div><label className="filter-select"><Filter size={15} /><select aria-label="Filtrar por estado" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="">Todos los estados</option>{statuses.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></label><span className="result-count">{posts.length} {posts.length === 1 ? 'elemento' : 'elementos'}</span></div>
      {loading ? <LoadingState compact /> : posts.length ? <div className="table-wrap"><table><thead><tr><th>CONTENIDO</th><th>CATEGORÍA</th><th>ESTADO</th><th>PROGRAMACIÓN</th><th aria-label="Acciones" /></tr></thead><tbody>{posts.map((post) => <tr key={post.id}>
        <td><button className="post-title-button" onClick={() => setEditing(post)}>{post.title}</button><small>{post.platform} · Actualizado {formatDate(post.updatedAt)}</small></td><td><span className="category-label">{post.category}</span></td><td><StatusBadge status={post.status} /></td><td className="date-cell">{formatDate(post.scheduledAt, { hour: '2-digit', minute: '2-digit' })}</td><td><div className="row-actions"><button className="small-action" onClick={() => setEditing(post)}>Editar</button>{['draft', 'pending_review', 'approved'].includes(post.status) && <Link className="small-action" to={`/media-studio?postId=${post.id}`}>Crear video</Link>}<button className="small-action danger-text" onClick={() => void remove(post)}>Eliminar</button></div></td>
      </tr>)}</tbody></table></div> : <EmptyState icon={<FileText size={21} />} title={search || filter ? 'No encontramos contenido' : 'Aún no hay contenido'} text={search || filter ? 'Prueba cambiando la búsqueda o el filtro.' : 'Crea tu primer borrador para comenzar a organizar ideas.'} action={!search && !filter && <button className="button secondary" onClick={() => setEditing(null)}><Plus size={15} /> Crear borrador</button>} />}
    </section>
    {editing !== false && <PostModal post={editing} onClose={() => setEditing(false)} onSave={save} />}
  </>;
}

function PostModal({ post, scheduledAt, onClose, onSave }: { post: Post | null; scheduledAt?: string; onClose: () => void; onSave: (input: PostInput) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState<PostInput>({
    title: post?.title || '',
    platform: post?.platform || 'TikTok',
    category: post?.category || 'Entretenimiento',
    body: post?.body || '',
    hashtags: post?.hashtags || '',
    source: post?.source || 'Idea propia',
    status: post?.status || 'draft',
    scheduledAt: localDateTime(post?.scheduledAt || scheduledAt || null) ? toIsoDateTime(localDateTime(post?.scheduledAt || scheduledAt || null)) : null,
  });
  const availableStatuses: PostStatus[] = post ? [post.status, ...allowedTransitions[post.status]] : ['idea', 'draft'];
  const set = (key: keyof PostInput, value: string | null) => setForm((current) => ({ ...current, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (form.status === 'scheduled' && !form.scheduledAt) { setError('Selecciona fecha y hora para programar.'); return; }
    setSaving(true);
    try { await onSave(form); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="post-modal-title">
    <div className="modal-heading"><div><div className="eyebrow">{post ? 'EDICIÓN' : 'NUEVO ELEMENTO'}</div><h2 id="post-modal-title">{post ? 'Editar contenido' : 'Crear contenido'}</h2></div><button className="icon-button" onClick={onClose} aria-label="Cerrar"><X size={18} /></button></div>
    <form onSubmit={(event) => void submit(event)} className="post-form">
      <label>Título interno<input autoFocus maxLength={160} required value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Ej. 3 ideas para empezar el día" /></label>
      <div className="form-row"><label>Categoría<select value={form.category} onChange={(e) => set('category', e.target.value)}>{['Memes originales', 'Tendencias', 'Entretenimiento', 'Historias originales', 'Curiosidades', 'Noticias verificadas', 'Educativo ligero'].map((item) => <option key={item}>{item}</option>)}</select></label><label>Estado<select value={form.status} onChange={(e) => set('status', e.target.value as PostStatus)}>{availableStatuses.map((item) => <option value={item} key={item}>{statusLabels[item]}</option>)}</select></label></div>
      <label>Texto o descripción<textarea rows={4} maxLength={5000} value={form.body} onChange={(e) => set('body', e.target.value)} placeholder="Escribe el guion o la descripción..." /></label>
      <label>Hashtags<input value={form.hashtags} onChange={(e) => set('hashtags', e.target.value)} placeholder="#ideas #creatividad" /></label>
      <div className="form-row"><label>Fuente de la idea<input value={form.source} onChange={(e) => set('source', e.target.value)} /></label><label>Fecha objetivo{form.status === 'scheduled' && <span className="required-label">obligatoria</span>}<input type="datetime-local" required={form.status === 'scheduled'} value={localDateTime(form.scheduledAt)} onChange={(e) => set('scheduledAt', toIsoDateTime(e.target.value))} /></label></div>
      {error && <div className="inline-error"><AlertCircle size={15} />{error}</div>}
      <div className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>Cancelar</button><button disabled={saving} className="button primary">{saving && <LoaderCircle size={15} className="spin" />}{saving ? 'Guardando...' : post ? 'Guardar cambios' : 'Crear borrador'}</button></div>
    </form>
  </section></div>;
}

function CalendarPage({ onNotice }: { onNotice: (notice: Notice) => void }) {
  const [anchor, setAnchor] = useState(() => new Date());
  const [view, setView] = useState<'month' | 'week' | 'day'>('month');
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ post: Post | null; datetime?: string } | false>(false);
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const first = new Date(year, month, 1);
  const calendarStart = view === 'month'
    ? new Date(year, month, 1 - ((first.getDay() + 6) % 7))
    : view === 'week'
      ? new Date(year, month, anchor.getDate() - ((anchor.getDay() + 6) % 7))
      : new Date(year, month, anchor.getDate());
  const calendarEnd = new Date(calendarStart);
  calendarEnd.setDate(calendarEnd.getDate() + (view === 'month' ? 42 : view === 'week' ? 7 : 1));
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    api.calendar(calendarStart, calendarEnd).then((items) => { if (mounted) { setPosts(items); setError(''); } }).catch((e: Error) => { if (mounted) setError(e.message); }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [calendarStart.getTime(), calendarEnd.getTime()]);
  const days = Array.from({ length: view === 'month' ? 42 : view === 'week' ? 7 : 1 }, (_, index) => {
    const day = new Date(calendarStart);
    day.setDate(day.getDate() + index);
    return day;
  });
  function move(direction: number) {
    const next = new Date(anchor);
    if (view === 'month') next.setMonth(next.getMonth() + direction, 1);
    else next.setDate(next.getDate() + direction * (view === 'week' ? 7 : 1));
    setAnchor(next);
  }
  async function save(input: PostInput) {
    try {
      if (editing && editing.post) await api.updatePost(editing.post.id, input);
      else await api.createPost(input);
      setEditing(false);
      onNotice({ kind: 'success', text: 'La programación quedó guardada.' });
      const items = await api.calendar(calendarStart, calendarEnd);
      setPosts(items);
    } catch (e) { onNotice({ kind: 'error', text: (e as Error).message }); }
  }
  const heading = new Intl.DateTimeFormat('es-MX', view === 'day'
    ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
    : view === 'week'
      ? { day: 'numeric', month: 'short' }
      : { month: 'long', year: 'numeric' }).format(anchor);
  return <>
    <PageHeading eyebrow="PLANIFICACIÓN" title="Calendario editorial" subtitle="Organiza fechas objetivo y publicaciones aprobadas. La programación es interna; no publica en TikTok." actions={<button className="button primary" onClick={() => setEditing({ post: null, datetime: new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 12).toISOString() })}><Plus size={17} /> Agregar borrador</button>} />
    {error && <ErrorBanner message={error} retry={() => { setAnchor(new Date(anchor)); }} />}
    <section className="panel calendar-panel">
      <div className="calendar-toolbar"><div className="calendar-nav"><button className="icon-button" aria-label="Periodo anterior" onClick={() => move(-1)}><ArrowLeft size={16} /></button><button className="button secondary today-button" onClick={() => setAnchor(new Date())}>Hoy</button><button className="icon-button" aria-label="Periodo siguiente" onClick={() => move(1)}><ArrowRight size={16} /></button><h2>{heading}</h2></div><div className="view-toggle">{(['month', 'week', 'day'] as const).map((item) => <button className={view === item ? 'selected' : ''} key={item} onClick={() => setView(item)}>{item === 'month' ? 'Mes' : item === 'week' ? 'Semana' : 'Día'}</button>)}</div></div>
      <div className={`calendar-grid ${view}`}>
        {['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((label) => <div className="weekday" key={label}>{label}</div>)}
        {days.map((day, index) => {
          const items = posts.filter((post) => post.scheduledAt && new Date(post.scheduledAt).toDateString() === day.toDateString());
          const inMonth = day.getMonth() === month;
          return <div className={`calendar-day${!inMonth && view === 'month' ? ' outside' : ''}${day.toDateString() === new Date().toDateString() ? ' today' : ''}`} key={`${day.toISOString()}-${index}`}>
            <button className="day-number" onClick={() => setEditing({ post: null, datetime: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12).toISOString() })}>{day.getDate()} <Plus size={12} /></button>
            {items.map((post) => <button key={post.id} className="calendar-event" onClick={() => setEditing({ post })}><span className="event-dot" />{post.title}<small>{new Date(post.scheduledAt!).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}</small></button>)}
          </div>;
        })}
      </div>
      {loading && <div className="calendar-loading"><LoaderCircle size={15} className="spin" /> Sincronizando calendario...</div>}
      {!loading && posts.length === 0 && <div className="calendar-empty">No hay elementos programados para este periodo. Usa <b>Programar contenido</b> para agregar uno.</div>}
    </section>
    {editing !== false && <PostModal post={editing.post} scheduledAt={editing.datetime} onClose={() => setEditing(false)} onSave={save} />}
  </>;
}

function QueuePage({ onNotice }: { onNotice: (notice: Notice) => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  async function refresh() {
    setLoading(true);
    try { const [jobData, postData] = await Promise.all([api.jobs(), api.posts()]); setJobs(jobData); setPosts(postData); setError(''); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); const id = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(id); }, []);
  const eligible = posts.filter((post) => ['approved', 'scheduled'].includes(post.status));
  async function runTest(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try { await api.createJob(selected); await refresh(); onNotice({ kind: 'success', text: 'Prueba local agregada a la cola. No se publicará contenido externo.' }); }
    catch (e) { onNotice({ kind: 'error', text: (e as Error).message }); }
    finally { setSubmitting(false); }
  }
  return <>
    <PageHeading eyebrow="PROCESAMIENTO LOCAL" title="Cola de trabajos" subtitle="Prueba la persistencia y el procesamiento sin enviar publicaciones a ninguna plataforma." />
    {error && <ErrorBanner message={error} retry={() => void refresh()} />}
    <div className="notice-card"><div className="notice-icon"><AlertCircle size={18} /></div><div><strong>Modo seguro: pruebas locales</strong><p>Los trabajos de esta cola solo registran una simulación local verificable. No conectan con TikTok ni publican contenido.</p></div></div>
    <section className="panel queue-create"><div><h2>Encolar una prueba</h2><p>Requiere contenido aprobado o programado.</p></div><form onSubmit={(event) => void runTest(event)}><select required aria-label="Elegir contenido aprobado" value={selected} onChange={(e) => setSelected(e.target.value)}><option value="">Selecciona contenido...</option>{eligible.map((post) => <option value={post.id} key={post.id}>{post.title} · {statusLabels[post.status]}</option>)}</select><button className="button primary" disabled={!selected || submitting}>{submitting ? <LoaderCircle size={15} className="spin" /> : <Plus size={16} />}{submitting ? 'Encolando...' : 'Crear prueba local'}</button></form></section>
    <section className="panel queue-list"><div className="panel-heading"><div><h2>Historial de trabajos</h2><p>Persistido localmente en SQLite</p></div><button className="button secondary small-button" onClick={() => void refresh()}><Activity size={15} /> Actualizar</button></div>
      {loading && !jobs.length ? <LoadingState compact /> : jobs.length ? <div className="table-wrap"><table><thead><tr><th>TRABAJO</th><th>TIPO</th><th>ESTADO</th><th>INTENTOS</th><th>CREADO</th></tr></thead><tbody>{jobs.map((job) => <tr key={job.id}><td><strong>{job.postTitle}</strong><small className="job-id">{job.id}</small>{job.result && <small className="job-result">{JSON.parse(job.result).message}</small>}</td><td><span className="category-label">Prueba local</span></td><td><JobStatus status={job.status} /></td><td>{job.attempts}</td><td>{formatDate(job.createdAt, { hour: '2-digit', minute: '2-digit' })}</td></tr>)}</tbody></table></div> : <EmptyState icon={<ArrowDownToLine size={21} />} title="La cola está vacía" text="Aprueba o programa un borrador; después podrás ejecutar una prueba local segura." action={<Link to="/contenido" className="text-link">Abrir centro de contenido <ArrowRight size={14} /></Link>} />}
    </section>
  </>;
}

function PlaceholderPage({ title }: { title: string }) {
  const moduleInfo: Record<string, { icon: ReactNode; text: string }> = {
    'Generador con IA': { icon: <Sparkles size={21} />, text: 'No hay un proveedor de IA configurado. Esta función se activará al agregar un proveedor real; no se simularán respuestas de modelos.' },
    'Tendencias e investigación': { icon: <Lightbulb size={21} />, text: 'Las tendencias y noticias requieren fuentes identificables. Aún no hay fuentes conectadas ni datos consultados.' },
    Analítica: { icon: <TrendingUp size={21} />, text: 'No hay métricas verificadas disponibles todavía. Las gráficas aparecerán cuando se incorporen datos reales.' },
    Integraciones: { icon: <Activity size={21} />, text: 'No hay integraciones conectadas. La publicación externa permanece deshabilitada hasta disponer de autorización oficial.' },
    Automatizaciones: { icon: <Clapperboard size={21} />, text: 'Administra tareas locales y externas persistentes, con control explícito de autorización, reintentos y disponibilidad.' },
    Configuración: { icon: <Settings2 size={21} />, text: 'Ajusta la prioridad del router de proveedores y comprueba el estado real de sus modelos. Las credenciales se configuran únicamente en el servidor local.' },
  };
  const info = moduleInfo[title] || { icon: <CircleHelp size={21} />, text: 'Este módulo aún no está habilitado.' };
  const [backup, setBackup] = useState('');
  const [backingUp, setBackingUp] = useState(false);
  async function createBackup() {
    setBackingUp(true);
    try {
      const result = await api.createBackup();
      setBackup(result.path);
    } catch (e) {
      setBackup(`Error: ${(e as Error).message}`);
    } finally {
      setBackingUp(false);
    }
  }
  if (title === 'Configuración') {
    return <><PageHeading eyebrow="SISTEMA" title="Configuración" subtitle="Proveedores de IA y ajustes locales de VYRALIX." /><AiProviders /><section className="panel backup-settings"><div><h2>Respaldo local</h2><p>La copia se guarda junto a la base de datos dentro de la carpeta backups.</p></div><div className="backup-action"><button className="button secondary" onClick={() => void createBackup()} disabled={backingUp}>{backingUp ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />}{backingUp ? 'Creando respaldo...' : 'Crear respaldo de SQLite'}</button>{backup && <small>{backup.startsWith('Error:') ? backup : `Respaldo creado: ${backup}`}</small>}</div></section></>;
  }
  return <><PageHeading eyebrow="MÓDULO VYRALIX" title={title} subtitle="Capacidades desarrolladas por etapas, con estados reales y sin integraciones ficticias." /><section className="panel placeholder-panel"><div className="placeholder-icon">{info.icon}</div><span className="panel-caption">MÓDULO PENDIENTE</span><h2>Estamos preparando este espacio</h2><p>{info.text}</p><Link to="/" className="button secondary"><ArrowLeft size={15} /> Volver al dashboard</Link></section></>;
}

function StatusBadge({ status }: { status: PostStatus }) {
  return <span className={`status-badge ${status}`}>{statusLabels[status]}</span>;
}
function JobStatus({ status }: { status: Job['status'] }) {
  const labels = { pending: 'Pendiente', processing: 'Procesando', completed: 'Completado', error: 'Error' };
  return <span className={`status-badge ${status}`}>{labels[status]}</span>;
}
function LoadingState({ compact = false }: { compact?: boolean }) {
  return <div className={`loading-state${compact ? ' compact' : ''}`}><LoaderCircle size={19} className="spin" /><span>Cargando datos locales...</span></div>;
}
function ErrorBanner({ message, retry }: { message: string; retry: () => void }) {
  return <div className="error-banner"><AlertCircle size={17} /><span>{message}</span><button onClick={retry}>Reintentar</button></div>;
}
function EmptyState({ icon, title, text, action }: { icon?: ReactNode; title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state">{icon && <div className="empty-icon">{icon}</div>}<strong>{title}</strong><p>{text}</p>{action}</div>;
}

export default App;
