import React, {useState, useEffect, useMemo, lazy, Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import '@fontsource-variable/inter';
import './style.css';
import {Icon, Logo} from './icons.jsx';
import {installGlass} from './glass.js';
import {installSeg} from './seg.js';
import {NavSkeleton} from './skeletons.jsx';
import {REMOTE, fetchSnapshot, nodeFetch, onChange, state as remoteState, signIn, signOut, refreshNodes} from './remote.js';
import {Avatar, ConfirmHost, DAY, PageSkeleton, ToastHost, ago, api, applyDensity, avatarAt, fmt, fresh, key, pref, reduceMotion, setPref, short, shortDate, thumbProps, toast, today, yt} from './shared.jsx';
import {Overview} from './pages/overview.jsx';

// Pages load when first opened. After a new deploy an old page file may be gone: reload once to get the new ones.
const page = (load, name) => lazy(() => load().then(m => ({default: m[name]})).catch(err => {
  try { if (!sessionStorage.getItem('cs.reloaded')) { sessionStorage.setItem('cs.reloaded', '1'); location.reload(); return new Promise(() => {}); } } catch {}
  throw err;
}));
try { sessionStorage.removeItem('cs.reloaded'); } catch {}
const Alerts = page(() => import('./pages/alerts.jsx'), 'Alerts');
const ChannelPage = page(() => import('./pages/channel.jsx'), 'ChannelPage');
const Competitors = page(() => import('./pages/competitors.jsx'), 'Competitors');
const DatabasePage = page(() => import('./pages/database.jsx'), 'DatabasePage');
const Insights = page(() => import('./pages/insights.jsx'), 'Insights');
const LookupPage = page(() => import('./pages/channel.jsx'), 'LookupPage');
const NodesPage = page(() => import('./pages/nodes.jsx'), 'NodesPage');
const Planner = page(() => import('./pages/planner.jsx'), 'Planner');
const Rankings = page(() => import('./pages/rankings.jsx'), 'Rankings');
const Report = page(() => import('./pages/report.jsx'), 'Report');
const Settings = page(() => import('./pages/settings.jsx'), 'Settings');
const Thumbnails = page(() => import('./pages/thumbnails.jsx'), 'Thumbnails');

const statuses = ['Idea','In production','Scheduled','Published'];

const formats = ['Long-form','Short'];

function loadPlanner() {
  try { const saved = JSON.parse(localStorage.getItem(key)); return Array.isArray(saved?.videos) ? saved.videos : []; }
  catch { return []; }
}

// Right-hand column on the Overview (wide screens; drops below the main content on smaller ones).
const RAIL_SEV = {critical: 'var(--down)', high: '#ff9f0a', medium: '#ffd60a', info: 'var(--muted)'};

function OverviewRail({data, own, competitors, open, onRefresh, onSearch}) {
  // Today: last 24h vs the 24h before that.
  const sum = (k, f) => own.every(c => !c.deltas[k]) ? null : own.reduce((t, c) => t + (c.deltas[k]?.[f] ?? 0), 0);
  const today = {v: sum('day', 'v'), s: sum('day', 's')}, two = {v: sum('day2', 'v'), s: sum('day2', 's')};
  const prev = {v: today.v != null && two.v != null ? two.v - today.v : null, s: today.s != null && two.s != null ? two.s - today.s : null};
  // If the dashboard wasn't running, the nearest snapshot can be much older than 24h: say so instead of comparing.
  const oldest = Math.min(...own.map(c => c.deltas.day ? Date.parse(c.deltas.day.since) : Date.now()));
  const gap = Date.now() - oldest > 30 * 3600e3;
  if (gap) { prev.v = prev.s = null; }
  const upToday = own.flatMap(c => c.recent).filter(v => Date.now() - Date.parse(v.published) < DAY).length;
  const vs = (now, before) => before == null || now == null || !before ? null : (now - before) / Math.abs(before) * 100;
  const Trend = ({p}) => p == null ? null : <span className={'rail-trend '+(p >= 0 ? 'up' : 'down')}>{p >= 0 ? '▲' : '▼'} {Math.abs(p).toFixed(0)}%</span>;

  const incidents = (data.rankings.watchdog?.incidents ?? []).filter(i => i.state !== 'resolved').slice(0, 5);
  const cats = new Map(data.rankings.categories.map(c => [c.id, c.name]));
  const rivalUploads = competitors.flatMap(c => c.recent.map(v => ({...v, ch: c}))).filter(v => Date.now() - Date.parse(v.published) < 7 * DAY)
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published)).slice(0, 5);
  const upcoming = data.plans.filter(p => p.status === 'Scheduled' || p.status === 'In production').slice(0, 4);
  const gaps = own.map(c => { const last = c.recent[0]?.published; return {c, days: last ? (Date.now() - Date.parse(last)) / DAY : null}; });
  const w = data.rankings.worker ?? {}, st = data.status, dates = data.dates;

  return <aside className="ov-rail" aria-label="At a glance">
    <section className="card rail-card">
      <div className="rail-head"><h3>Last 24 hours</h3><span className="muted small">{gap ? 'since '+ago(new Date(oldest).toISOString())+' (no data in between)' : 'vs the day before'}</span></div>
      <div className="rail-today">
        <div><span className="kpi-label">Views</span><strong>{today.v == null ? '—' : '+'+short(today.v)}</strong><Trend p={vs(today.v, prev.v)}/></div>
        <div><span className="kpi-label">Subscribers</span><strong>{today.s == null ? '—' : (today.s >= 0 ? '+' : '')+short(today.s)}</strong><Trend p={vs(today.s, prev.s)}/></div>
        <div><span className="kpi-label">Uploads</span><strong>{upToday}</strong><span className="muted small">all channels</span></div>
      </div>
      <div className="rail-split">{own.map(c => <div key={c.id} className="rail-split-row" onClick={() => open('ch:'+c.id)}>
        <Avatar channel={c} size={18}/><span>{c.name}</span><span className="muted small">{c.deltas.day ? '+'+short(c.deltas.day.v)+' views' : 'collecting'}</span></div>)}</div>
    </section>

    <section className="card rail-card">
      <div className="rail-head"><h3>Ranking alerts</h3><button className="link-btn" onClick={() => open('rankings')}>Rankings →</button></div>
      {incidents.length ? <ul className="rail-list">{incidents.map(i => <li key={i.id} onClick={() => open('rankings')} title={i.title}>
        <span className="sev-dot" style={{background: RAIL_SEV[i.severity] ?? RAIL_SEV.info}}/>
        <span className="rail-t">{i.title}</span><span className="muted small">{ago(i.last_seen)}</span></li>)}</ul>
        : <div className="rail-empty">✓ No open ranking problems</div>}
    </section>

    <section className="card rail-card">
      <div className="rail-head"><h3>Competitor uploads</h3><span className="muted small">last 7 days</span></div>
      {rivalUploads.length ? <ul className="rail-list rail-videos">{rivalUploads.map(v => <li key={v.id}>
        <a href={'https://youtu.be/'+v.id} target="_blank" rel="noreferrer">
          <img {...thumbProps(v.thumbnail ?? v.id, '72px')} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"/>
          <span className="rail-v"><span className="rail-t">{v.title}</span>
            <span className="muted small">{v.ch.name} · {ago(v.published)} · {short(v.views)} views{v.score != null && <> · <b className={v.score >= 2 ? 'up' : v.score < 0.5 ? 'down' : ''}>{v.score.toFixed(1)}×</b></>}</span></span></a></li>)}</ul>
        : <div className="rail-empty">No competitor uploads this week.</div>}
    </section>

    <section className="card rail-card">
      <div className="rail-head"><h3>Upload schedule</h3><button className="link-btn" onClick={() => open('planner')}>Planner →</button></div>
      <ul className="rail-list">{gaps.map(({c, days}) => <li key={c.id} onClick={() => open('ch:'+c.id)}>
        <Avatar channel={c} size={18}/><span className="rail-t">{c.name}</span>
        <span className={'small '+(days > 3 ? 'down' : 'muted')}>{days == null ? 'no uploads yet' : days < 1 ? 'posted today' : 'last upload '+Math.floor(days)+'d ago'}</span></li>)}</ul>
      {upcoming.length ? <ul className="rail-list rail-plans">{upcoming.map(p => <li key={p.id} onClick={() => open('planner')}>
        <span className="pill">{p.status === 'Scheduled' ? (p.date ? shortDate(p.date) : 'Scheduled') : 'In production'}</span><span className="rail-t">{p.title || 'Untitled'}</span></li>)}</ul>
        : <div className="rail-empty">Nothing scheduled. <button className="link-btn" onClick={() => open('planner')}>Plan a video</button></div>}
    </section>

    <section className="card rail-card">
      <div className="rail-head"><h3>Status</h3></div>
      <ul className="rail-status">
        <li><span>Channel update</span><span className="muted">{st.running ? 'running now' : st.nextRun ? 'next in '+Math.max(0, Math.round((Date.parse(st.nextRun) - Date.now()) / 60e3))+' min' : 'off'}</span></li>
        <li><span>Search rankings</span><span className="muted">{w.pausedUntil ? 'paused until '+new Date(w.pausedUntil).toLocaleTimeString('en-IN', {hour:'2-digit', minute:'2-digit'}) : (w.checkedToday ?? 0)+' / '+(w.total ?? 0)+' checked today'}</span></li>
        {dates && <li><span>Exact upload dates</span><span className="muted">{dates.remaining ? dates.remaining+' left · '+dates.done+' done' : 'all exact'}</span></li>}
      </ul>
      <div className="rail-actions">
        <button className="btn" onClick={onRefresh} disabled={st.running}>{st.running ? <span className="spinner"/> : 'Update now'}</button>
        <button className="btn" onClick={() => open('rankings')}>Rankings</button>
        <button className="btn" onClick={onSearch}>Search <kbd>Ctrl K</kbd></button>
        <button className="btn" onClick={() => open('competitors:'+own[0]?.id)}>Add competitor</button>
      </div>
    </section>
  </aside>;
}

applyDensity(pref('compact', false));

const applyTheme = t => t ? document.documentElement.setAttribute('data-theme', t) : document.documentElement.removeAttribute('data-theme');

applyTheme(pref('theme', null));

const currentTheme = () => document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

function ThemeButton() {
  const [t, setT] = useState(currentTheme);
  const flip = () => { const n = t === 'dark' ? 'light' : 'dark'; applyTheme(n); setPref('theme', n); setT(n); };
  return <button className="btn icon" onClick={flip} aria-label={'Switch to '+(t === 'dark' ? 'light' : 'dark')+' mode'} title={'Switch to '+(t === 'dark' ? 'light' : 'dark')+' mode'}><Icon name={t === 'dark' ? 'sun' : 'moon'}/></button>;
}

// ---------- command palette ----------
function CommandPalette({items, onClose, own = [], onOpen, onTrack}) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const list = React.useRef(null);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  // YouTube channel search, debounced; shown below the local matches.
  const [yt, setYt] = useState({q:'', list:[], busy:false});
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setYt({q:'', list:[], busy:false}); return; }
    setYt(y => ({...y, busy:true}));
    const ctl = new AbortController(), t = setTimeout(() => nodeFetch('/api/search/channels?q='+encodeURIComponent(term), {signal:ctl.signal})
      .then(r => r.ok ? r.json() : []).then(list => setYt({q:term, list, busy:false})).catch(e => e.name !== 'AbortError' && setYt({q:term, list:[], busy:false})), 450);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q]);
  const [adding, setAdding] = useState(null);
  const ytItems = yt.list.map(c => ({group:'YouTube channels', label:c.title, yt:c,
    hint:[c.handle, c.subscribers != null && short(c.subscribers)+' subs', c.tracked && (c.tracked.kind === 'own' ? 'your channel' : 'tracked')].filter(Boolean).join(' · '),
    icon:c.avatar ? <img className="avatar" src={avatarAt(c.avatar, 20)} width="20" height="20" alt="" loading="lazy" referrerPolicy="no-referrer" style={{borderRadius:'50%'}}/> : null,
    run:() => onOpen?.(c.tracked ? 'ch:'+c.tracked.id : 'yt:'+c.channelId)}));
  const local = (terms.length ? items.filter(it => terms.every(t => it.hay.includes(t))) : items.filter(it => it.group !== 'Videos')).slice(0, 40);
  const hits = [...local, ...ytItems];
  const track = async (c, o) => { setAdding(c.channelId+':'+o.id); try { await onTrack(c.handle ?? c.channelId, o.id); toast(`${c.title} added as a competitor of ${o.name}.`, {kind:'ok'}); onClose(); } catch (err) { toast(err.message, {kind:'error'}); } finally { setAdding(null); } };
  const pick = it => { onClose(); it.run(); };
  useEffect(() => { setI(0); }, [q]);
  useEffect(() => { list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({block:'nearest'}); }, [i]);
  const key = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setI(n => Math.min(hits.length - 1, n + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI(n => Math.max(0, n - 1)); }
    else if (e.key === 'Enter' && hits[i]) pick(hits[i]);
    else if (e.key === 'Escape') onClose();
  };
  let last = null;
  return <div className="modal-back palette-back" onClick={onClose}>
    <div className="palette" role="dialog" aria-label="Search" onClick={e => e.stopPropagation()}>
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} onKeyDown={key} placeholder="Search pages, channels, videos, budgets, or any YouTube channel…" aria-label="Search"/>
      <div className="palette-list" ref={list} role="listbox">
        {hits.map((it, n) => { const head = it.group !== last; last = it.group; return <React.Fragment key={it.group+it.label+n}>
          {head && <div className="palette-group">{it.group}</div>}
          <button role="option" aria-selected={n === i} className="palette-item" onMouseMove={() => setI(n)} onClick={() => pick(it)}>
            {it.icon ?? <span className="nav-icon">›</span>}<span className="pi-label">{it.label}</span>{it.hint && <span className="muted small">{it.hint}</span>}
            {it.yt && !it.yt.tracked && onTrack && <span className="pi-track" onClick={e => e.stopPropagation()}>{own.map(o => <span key={o.id} role="button" tabIndex={-1} className="chip-btn" title={'Track as a competitor of '+o.name}
              onClick={() => track(it.yt, o)}>{adding === it.yt.channelId+':'+o.id ? <span className="spinner"/> : '+ '+o.name}</span>)}</span>}</button>
        </React.Fragment>; })}
        {yt.busy && <div className="palette-group">YouTube channels <span className="spinner"/></div>}
        {!hits.length && !yt.busy && <div className="spark-empty">No matches for “{q}”.</div>}
      </div>
      <div className="palette-foot muted small"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
    </div>
  </div>;
}

// ---------- error boundary ----------
class Boundary extends React.Component {
  state = {error:null};
  static getDerivedStateFromError(error) { return {error}; }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({error:null}); }
  render() {
    if (!this.state.error) return this.props.children;
    return <section className="card error-card"><h2>This section hit an error</h2><p className="muted small">{String(this.state.error.message || this.state.error)}</p>
      <button className="btn" onClick={() => this.setState({error:null})}>Try again</button></section>;
  }
}

// ---------- images: fade in, fall back on error ----------
if (typeof document !== 'undefined') {
  document.addEventListener('load', e => e.target.tagName === 'IMG' && e.target.classList.add('loaded'), true);
  document.addEventListener('error', e => { if (e.target.tagName === 'IMG') e.target.classList.add('broken'); }, true);
}

// ---------- connection banner ----------
function ConnectionBanner({conn, retryIn, onRetry, stale}) {
  const r = useRemote();
  if (conn === 'ok') return null;
  const msg = conn === 'offline' ? 'You’re offline.' : REMOTE ? 'None of your nodes is answering. Is one of the PCs on?' : 'Can’t reach the dashboard server.';
  const note = conn === 'snapshot' ? `Showing the copy saved ${r.snapshotAt ? ago(r.snapshotAt) : 'earlier'} in the database. It’s read-only until a node is back.`
    : stale ? 'Showing data from '+ago(stale)+'.' : '';
  return <div className={'conn-banner '+conn} role="alert">
    <span className="conn-dot"/><span><b>{msg}</b> {note} {retryIn > 0 ? 'Retrying in '+retryIn+'s…' : 'Retrying…'}</span>
    <button className="btn" onClick={onRetry} disabled={retryIn === 0}>{retryIn === 0 ? <span className="spinner"/> : 'Retry now'}</button>
  </div>;
}

const scoreClass = n => n == null ? '' : n >= 70 ? 'sc-good' : n >= 40 ? 'sc-mid' : 'sc-bad';

// Measures an element's real pixel width so charts draw at true size instead of being stretched.
function useWidth(fallback = 600) {
  const [w, setW] = useState(fallback);
  const ro = React.useRef(null);
  // Callback ref: re-attaches whenever the measured element is swapped (placeholder → chart).
  const ref = React.useCallback(el => {
    ro.current?.disconnect();
    if (!el) return;
    ro.current = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))));
    ro.current.observe(el);
  }, []);
  useEffect(() => () => ro.current?.disconnect(), []);
  return [ref, w];
}

// ---------- app ----------
function App() {
  const [raw, setData] = useState(null);
  const [pending, setPending] = useState(() => new Set());
  const commits = React.useRef(new Map());
  const data = useMemo(() => raw && pending.size ? {...raw,
    plans: raw.plans.filter(p => !pending.has('plan:'+p.id)),
    channels: raw.channels.filter(c => !pending.has('comp:'+c.id)).map(c => c.kind === 'competitor' ? {...c, rivalOf:c.rivalOf.filter(o => !pending.has('link:'+o+':'+c.id))} : c).filter(c => c.kind === 'own' || c.rivalOf.length),
    rankings: {...raw.rankings, categories: raw.rankings.categories.filter(c => !pending.has('cat:'+c.id)).map(c => ({...c, subs:c.subs.filter(s => !pending.has('sub:'+s.id))}))}
  } : raw, [raw, pending]);
  const unpend = k => setPending(p => { const n = new Set(p); n.delete(k); return n; });
  // Deletes are hidden at once and only sent after the undo window closes.
  function undo(k, label, commit) {
    setPending(p => new Set(p).add(k));
    const fire = () => { clearTimeout(timer); commits.current.delete(k); return commit().catch(err => toast(err.message, {kind:'error'})).finally(() => unpend(k)); };
    const timer = setTimeout(fire, 6000);
    commits.current.set(k, fire);
    toast(label, {ttl:6000, action:{label:'Undo', run:() => { clearTimeout(timer); commits.current.delete(k); unpend(k); }}});
    return Promise.resolve();
  }
  useEffect(() => { const flush = () => commits.current.forEach(f => f()); addEventListener('pagehide', flush); return () => removeEventListener('pagehide', flush); }, []);
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const k = e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(o => !o); } };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, []);
  const [visits, setVisits] = useState(() => pref('seen', {}));
  const boot = React.useRef(pref('boot', null) ?? (setPref('boot', new Date().toISOString()), new Date().toISOString()));
  const [page, setPage] = useState(() => location.hash.slice(1) || 'overview');
  const [refreshing, setRefreshing] = useState(false);
  const [conn, setConn] = useState('ok');
  const [retryIn, setRetryIn] = useState(-1);
  const connRef = React.useRef('ok'), attempt = React.useRef(0);
  const setNotice = m => m && toast(m, {kind:'error'});
  const [, tick] = useState(0);
  const seen = React.useRef(null);
  useEffect(() => { setVisits(sn => { const n = {...sn, [page]:new Date().toISOString()}; setPref('seen', n); return n; }); }, [page]);
  useEffect(() => { const h = () => setPage(location.hash.slice(1) || 'overview'); addEventListener('hashchange', h); return () => removeEventListener('hashchange', h); }, []);
  useEffect(() => { if (location.hash.slice(1) !== (page === 'overview' ? '' : page)) history.pushState(null, '', page === 'overview' ? location.pathname : '#'+page); window.scrollTo({top:0, behavior:reduceMotion() ? 'auto' : 'smooth'}); }, [page]);

  function apply(d) {
    // Desktop notification for alerts that arrived since the last load.
    if (seen.current != null && typeof Notification !== 'undefined' && Notification.permission === 'granted')
      d.alerts.filter(a => a.id > seen.current && !a.read).slice(0, 3).forEach(a => new Notification(a.title, {body:a.body ?? '', tag:'yt-'+a.id}));
    seen.current = Math.max(0, ...d.alerts.map(a => a.id));
    setData(d);
    // remembered so the next load's skeleton draws as many channel cards and sidebar rows as there are
    const ownIds = d.channels.filter(c => c.kind === 'own').map(c => c.id);
    setPref('skel', {own:ownIds.length, rivals:Object.fromEntries(ownIds.map(id => [id, d.channels.filter(c => c.rivalOf?.includes(id)).length]))});
  }
  const live = React.useRef(false);   // live data from a node has been shown at least once
  const reload = () => api('/api/dashboard').then(d => {
    apply(d); live.current = true;
    if (connRef.current !== 'ok') toast('Back online. Data is up to date.', {kind:'ok'});
    connRef.current = 'ok'; attempt.current = 0; setConn('ok'); setRetryIn(-1);
  }).catch(async err => {
    if (err.kind === 'http') return toast(err.message, {kind:'error'});
    // On Vercel with no node answering: show the copy saved in the shared database (unless live data is already
    // on screen, which is newer), and keep retrying so the page goes live as soon as a node is back.
    const snap = REMOTE && !live.current && err.kind !== 'auth' && navigator.onLine !== false ? await fetchSnapshot() : null;
    if (snap) apply(snap);
    connRef.current = snap ? 'snapshot' : navigator.onLine === false ? 'offline' : 'down'; setConn(connRef.current);
    const wait = Math.min(60, 5 * 2 ** attempt.current++); setRetryIn(wait);
  });
  // Auto-retry countdown while disconnected; reconnecting the network retries at once.
  useEffect(() => {
    if (retryIn < 0) return;
    if (retryIn === 0) { reload(); return; }
    const id = setTimeout(() => setRetryIn(n => n - 1), 1000);
    return () => clearTimeout(id);
  }, [retryIn]);
  useEffect(() => {
    const on = () => { attempt.current = 0; setRetryIn(0); }, off = () => { connRef.current = 'offline'; setConn('offline'); };
    addEventListener('online', on); addEventListener('offline', off);
    return () => { removeEventListener('online', on); removeEventListener('offline', off); };
  }, []);
  useEffect(() => {
    reload().then(async () => {
      // One-time move of the old browser-stored planner into the database.
      const old = loadPlanner();
      if (old.length) try { apply(await api('/api/plans/import', {method:'POST', body:JSON.stringify({videos:old})})); localStorage.removeItem(key); } catch {}
    });
    const poll = setInterval(() => connRef.current === 'ok' && reload(), 60e3), clock = setInterval(() => tick(t => t+1), 30e3);
    return () => { clearInterval(poll); clearInterval(clock); };
  }, []);

  const call = async (path, options) => {
    try { const d = await api(path, options); apply(d); return d; }
    catch (err) { if (err.kind !== 'http') reload(); throw err; }
  };
  async function refresh() {
    setRefreshing(true);
    try { await call('/api/refresh', {method:'POST'}); toast('Update finished.', {kind:'ok', ttl:3000}); }
    catch (err) { toast(err.message, {kind:'error', action:{label:'Retry', run:refresh}}); } finally { setRefreshing(false); }
  }
  const savePlan = p => call('/api/plans', {method:'POST', body:JSON.stringify(p)});
  const deletePlan = id => undo('plan:'+id, 'Video removed from the planner', () => call('/api/plans/'+id, {method:'DELETE'}));
  async function removeCompetitor(c) {
    setPage('competitors:'+(c.rivalOf[0] ?? own[0]?.id));
    undo('comp:'+c.id, 'Stopped tracking '+c.name, () => call('/api/competitors/'+c.id, {method:'DELETE'}));
  }
  useEffect(() => { if (page === 'alerts' && data?.unread) call('/api/alerts/read', {method:'POST'}).catch(() => {}); }, [page, data?.unread]);

  const own = data?.channels.filter(c => c.kind === 'own') ?? [];
  const ownRaw = own;
  const competitors = (data?.channels.filter(c => c.kind === 'competitor') ?? []).map(c => ({...c, rivalNames:c.rivalOf.map(id => ownRaw.find(o => o.id === id)?.name).filter(Boolean).join(', ')}));
  own.forEach(o => { o.rivals = competitors.filter(c => c.rivalOf.includes(o.id)).length; });
  const owner = page.startsWith('competitors') ? own.find(o => 'competitors:'+o.id === page) ?? own[0] : null;
  const current = page.startsWith('ch:') ? [...own, ...competitors].find(c => 'ch:'+c.id === page) : null;
  const status = data?.status;
  const titles = {nodes:'Nodes', database:'Database health', settings:'Settings', rankings:'Search rankings', overview:'Overview', competitors:'Competitors', insights:'Insights', report:'Weekly report', alerts:'Alerts', planner:'Planner', thumbnails:'Thumbnails'};
  const title = owner ? 'Competitors' : titles[page] ?? current?.name ?? 'Channel';
  const since = id => visits[id] ?? boot.current;
  const newVideos = (cs, t) => cs.reduce((n, c) => n + c.recent.filter(v => v.published > t).length, 0);
  const fresh = id => {
    if (!data || page === id) return 0;
    if (id.startsWith('ch:')) return newVideos(own.filter(c => 'ch:'+c.id === id), since(id));
    if (id.startsWith('competitors:')) return newVideos(competitors.filter(c => 'competitors:'+c.rivalOf.find(o => 'competitors:'+o === id) === id), since(id));
    if (id === 'rankings') return data.alerts.filter(a => a.kind === 'ranking' && a.ts > since(id)).length;
    if (id === 'insights' || id === 'report') return data.alerts.filter(a => a.kind === 'outlier' && a.ts > since(id)).length;
    return 0;
  };
  const nav = (id, label, extra, count, hot) => { const f = fresh(id); return <button className="nav-item" aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}>{extra}<span className="nav-text">{label}</span>{f ? <span className="fresh" title={f+' new since your last visit'}>+{f}</span> : null}{count ? <span className={'count'+(hot ? ' hot' : '')}>{count}</span> : null}</button>; };
  const paletteItems = !data ? [] : [
    ...Object.entries({overview:'Overview', insights:'Insights', rankings:'Search rankings', report:'Weekly report', alerts:'Alerts', settings:'Settings', database:'Database health', nodes:'Nodes', planner:'Planner & lookup', thumbnails:'Thumbnails'}).map(([k, l]) => ({group:'Pages', label:l, run:() => setPage(k)})),
    ...own.map(c => ({group:'Your channels', label:c.name, hint:short(c.subscribers)+' subs', icon:<Avatar channel={c} size={20}/>, run:() => setPage('ch:'+c.id)})),
    ...own.map(c => ({group:'Your channels', label:c.name+' rivals', run:() => setPage('competitors:'+c.id)})),
    ...competitors.map(c => ({group:'Competitors', label:c.name, hint:c.rivalNames, icon:<Avatar channel={c} size={20}/>, run:() => setPage('ch:'+c.id)})),
    ...data.rankings.categories.flatMap(cat => cat.subs.map(sb => ({group:'Rankings', label:cat.name+' · '+sb.name, hint:sb.status, run:() => setPage('rankings')}))),
    ...data.plans.map(pl => ({group:'Planner', label:pl.title || 'Untitled', hint:pl.status, run:() => setPage('planner')})),
    {group:'Actions', label:'Update now', run:refresh},
    {group:'Actions', label:'Toggle compact mode', run:() => { const v = !pref('compact', false); setPref('compact', v); applyDensity(v); }},
    ...data.channels.flatMap(c => c.recent.map(v => ({group:'Videos', label:v.title, hint:c.name+' · '+short(v.views)+' views', run:() => window.open('https://youtu.be/'+v.id, '_blank', 'noreferrer')})))
  ].map(it => ({...it, hay:(it.label+' '+(it.hint ?? '')+' '+it.group).toLowerCase()}));
  const minutesTo = t => Math.max(0, Math.round((new Date(t) - Date.now()) / 60e3));

  return <div className="shell">
    <ConfirmHost/><ToastHost/>
    {palette && <CommandPalette items={paletteItems} onClose={() => setPalette(false)} own={own} onOpen={setPage}
      onTrack={(input, ownId) => call('/api/competitors', {method:'POST', body:JSON.stringify({input, own:ownId})})}/>}
    <aside className="sidebar">
      <div className="brand"><span className="logo"><Logo/></span>Channel Studio</div>
      <nav aria-label="Main">
        <span className="nav-label">Dashboard</span>
        {nav('overview', 'Overview', <span className="nav-icon"><Icon name="overview"/></span>)}
        {nav('insights', 'Insights', <span className="nav-icon"><Icon name="insights"/></span>)}
        {nav('thumbnails', 'Thumbnails', <span className="nav-icon"><Icon name="thumbnails"/></span>)}
        {nav('rankings', 'Rankings', <span className="nav-icon"><Icon name="rankings"/></span>, data?.rankings.categories.flatMap(c => c.subs).filter(s => s.status === 'weak' || s.status === 'missing').length, true)}
        {nav('report', 'Weekly report', <span className="nav-icon"><Icon name="report"/></span>)}
        {nav('alerts', 'Alerts', <span className="nav-icon"><Icon name="alerts"/></span>, data?.unread, true)}
        <span className="nav-label">Your channels</span>
        {!data && <NavSkeleton n={pref('skel', {own:3}).own}/>}
        {own.map(c => <React.Fragment key={c.id}>{nav('ch:'+c.id, c.name, <Avatar channel={c} size={22}/>)}</React.Fragment>)}
        <span className="nav-label">Competitors</span>
        {!data && <NavSkeleton n={pref('skel', {own:3}).own} icon={18}/>}
        {own.map(o => <React.Fragment key={o.id}>{nav('competitors:'+o.id, o.name+' rivals', <span className="nav-icon" style={{color:o.color}}><Icon name="flag"/></span>, o.rivals)}</React.Fragment>)}
        <span className="nav-label">Tools</span>
        {nav('settings', 'Settings', <span className="nav-icon"><Icon name="settings"/></span>)}
        {nav('database', 'Database', <span className="nav-icon"><Icon name="database"/></span>)}
        {nav('nodes', 'Nodes', <span className="nav-icon"><Icon name="nodes"/></span>)}
        {nav('planner', 'Planner & lookup', <span className="nav-icon"><Icon name="planner"/></span>, data?.plans.filter(p => p.status !== 'Published').length)}
      </nav>
      <div className="side-foot">
        {status && <div className="sync">
          <span className={'sync-dot'+(status.running || refreshing ? ' live' : '')}/>
          <div><strong>{status.running || refreshing ? 'Updating now…' : 'Auto-update on'}</strong>
          <span>Every {status.intervalMinutes} min{status.nextRun && !status.running ? ' · next in '+minutesTo(status.nextRun)+' min' : ''}</span>
          <span>{fmt(status.db.videos)} videos · {fmt(status.db.channelSnapshots + status.db.videoSnapshots)} snapshots</span></div>
        </div>}
        <RemoteBadge/>
      </div>
    </aside>
    <main>
      <header className="topbar">
        <div><h1 className="page-title">{title}</h1><span className="muted small">{status?.lastRun ? 'Updated '+ago(status.lastRun.finished_at) : 'Waiting for first update'} · public YouTube data</span></div>
        <div className="row">
          <button className="btn search-btn" onClick={() => setPalette(true)} aria-label="Search (Ctrl+K)"><Icon name="search"/><span className="sb-text">Search</span><kbd>Ctrl K</kbd></button>
          <ThemeButton/>
          <button className="btn icon" onClick={() => setPage('alerts')} aria-label={'Alerts'+(data?.unread ? ', '+data.unread+' unread' : '')}><Icon name="alerts"/>{data?.unread ? <span className="bell">{data.unread}</span> : null}</button>
          <button className="btn primary" onClick={refresh} disabled={refreshing || status?.running}>{refreshing || status?.running ? <><span className="spinner"/>Updating</> : <><Icon name="refresh"/>Update now</>}</button>
        </div>
      </header>
      <ConnectionBanner conn={conn} retryIn={retryIn} stale={status?.lastRun?.finished_at} onRetry={() => { attempt.current = 0; setRetryIn(0); }}/>
      {!data && <PageSkeleton page={page}/>}
      <Boundary resetKey={page}><Suspense fallback={<PageSkeleton page={page}/>}><div key={page} className="page-enter">
      {data && page === 'overview' && <Overview own={own} open={setPage} rail={<OverviewRail data={data} own={own} competitors={competitors} open={setPage} onRefresh={refresh} onSearch={() => setPalette(true)}/>}/>}
      {data && page === 'insights' && <Insights channels={data.channels}/>}
      {data && page === 'thumbnails' && <Thumbnails channels={data.channels}/>}
      {data && page === 'settings' && <Settings data={data} call={call}/>}
      {data && page === 'database' && <DatabasePage/>}
      {data && page === 'nodes' && <NodesPage/>}
      {data && page === 'rankings' && <Rankings data={data} own={own} call={call} setNotice={setNotice} undo={undo}/>}
      {data && page === 'report' && <Report own={own} competitors={competitors} alerts={data.alerts}/>}
      {data && page === 'alerts' && <Alerts data={data} onRead={() => call('/api/alerts/read', {method:'POST'})} onSettings={() => setPage('settings')}/>}
      {data && owner && <Competitors owner={owner} own={own} competitors={competitors.filter(c => c.rivalOf.includes(owner.id))} open={setPage}
        onAdd={input => call('/api/competitors', {method:'POST', body:JSON.stringify({input, own:owner.id})})}
        onUnlink={c => undo('link:'+owner.id+':'+c.id, 'Removed '+c.name+' from '+owner.name, () => call('/api/competitors/'+c.id+'?own='+owner.id, {method:'DELETE'}))}
        onPlan={savePlan}/>}
      {data && current && <ChannelPage key={current.id} c={current} onRemove={current.kind === 'competitor' ? () => removeCompetitor(current) : null}/>}
      {data && page.startsWith('yt:') && <LookupPage key={page} channelId={page.slice(3)} own={own} onTracked={id => setPage('ch:'+id)}
        onTrack={(input, ownId) => call('/api/competitors', {method:'POST', body:JSON.stringify({input, own:ownId})})}/>}
      {data && page.startsWith('ch:') && !current && <div className="spark-empty">That channel is no longer tracked.</div>}
      {data && page === 'planner' && <Planner own={own} plans={data.plans} onSave={savePlan} onDelete={deletePlan}/>}
      </div></Suspense></Boundary>
    </main>
  </div>;
}

installGlass();
installSeg();

// Soft spotlight that follows the pointer over cards.
// At most once a frame: each update restyles the card, so raw pointer events (often 120+ a second) were wasted work.
if (typeof document !== 'undefined') {
  let ev = null, queued = 0;
  document.addEventListener('pointermove', e => {
    ev = e;
    queued ||= requestAnimationFrame(() => {
      queued = 0;
      const el = ev.target.closest?.('.card,.kpi'); if (!el) return;
      const b = el.getBoundingClientRect(); el.style.setProperty('--mx', (ev.clientX - b.left)+'px'); el.style.setProperty('--my', (ev.clientY - b.top)+'px');
    });
  }, {passive:true});
}

// ---------- remote mode (page on Vercel) ----------
function useRemote() {
  const [s, set] = useState(remoteState);
  useEffect(() => onChange(set), []);
  return s;
}

function SignIn() {
  const [pw, setPw] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const submit = async e => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await signIn(pw); } catch (x) { setErr(x.message); setBusy(false); }
  };
  return <div className="signin">
    <form className="signin-card" onSubmit={submit}>
      <div className="brand"><span className="brand-mark" aria-hidden="true">▶</span><strong>Channel Studio</strong></div>
      <p className="muted">Sign in to open your dashboard. It connects to your PCs (nodes) directly.</p>
      <label className="signin-field">Password<input type="password" autoComplete="current-password" autoFocus value={pw} onChange={e => setPw(e.target.value)} required/></label>
      {err && <p className="error small" role="alert">{err}</p>}
      <button className="btn primary" disabled={busy || !pw}>{busy ? <span className="spinner"/> : 'Sign in'}</button>
      <p className="muted small">You stay signed in on this browser for 30 days.</p>
    </form>
  </div>;
}

function RemoteBadge() {
  const r = useRemote(), [busy, setBusy] = useState(false);
  if (!REMOTE) return null;
  const n = r.node;
  const switchNode = async () => { setBusy(true); try { const x = await refreshNodes(); toast('Using '+x.name+' ('+x.ms+' ms).', {kind:'ok'}); } catch (e) { toast(e.message, {kind:'error'}); } finally { setBusy(false); } };
  return <div className="remote-badge">
    <span className={'sync-dot'+(n ? ' live' : ' off')}/>
    <div><strong>{n ? 'Via '+n.name : r.snapshotAt ? 'Saved copy · no node online' : 'Finding a node…'}</strong>
      <span>{n ? (n.ms != null ? n.ms+' ms · ' : '')+r.nodes.filter(x => x.ms != null).length+' node'+(r.nodes.filter(x => x.ms != null).length === 1 ? '' : 's')+' online' : r.snapshotAt ? 'read-only · '+ago(r.snapshotAt) : 'connecting'}</span>
      <span className="row" style={{gap:10}}><button className="link-btn" disabled={busy} onClick={switchNode}>{busy ? 'Checking…' : 'Re-check'}</button><button className="link-btn" onClick={() => signOut()}>Sign out</button></span></div>
  </div>;
}

function Root() {
  const r = useRemote();
  if (REMOTE && !r.signedIn) return <SignIn/>;
  return <App/>;
}

createRoot(document.getElementById('root')).render(<Root/>);
