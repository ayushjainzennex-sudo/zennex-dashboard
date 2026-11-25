import React, {useState, useEffect, useMemo} from 'react';
import {REMOTE, nodeFetch, onChange} from './remote.js';

const key = 'youtube-dashboard-v1';

const DAY = 864e5;

const num = new Intl.NumberFormat('en-IN');

const compact = new Intl.NumberFormat('en', {notation:'compact', maximumFractionDigits:1});

const fmt = n => n == null || Number.isNaN(n) ? '—' : num.format(Math.round(n));

const short = n => n == null || Number.isNaN(n) ? '—' : compact.format(n);

const today = () => new Date().toISOString().slice(0,10);

function ago(date) {
  if (!date) return '—';
  const s = (Date.now() - new Date(date)) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s/60))+'m ago';
  if (s < 86400) return Math.round(s/3600)+'h ago';
  if (s < 86400*30) return Math.round(s/86400)+'d ago';
  return new Date(date).toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'});
}

const duration = s => { s = Number(s); const h = Math.floor(s/3600), m = Math.floor(s%3600/60), sec = String(s%60).padStart(2,'0'); return (h ? h+':'+String(m).padStart(2,'0') : m)+':'+sec; };

const avg = list => list.length ? list.reduce((a,b) => a+b, 0) / list.length : null;

function stats(channel) {
  const recent = channel.recent ?? [];
  const shorts = recent.filter(v => v.short), longs = recent.filter(v => !v.short);
  const last30 = recent.filter(v => Date.now() - new Date(v.published) < 30*DAY);
  return {
    recent, shorts, longs, last30,
    avgLifetime: channel.videoCount ? channel.totalViews / channel.videoCount : null,
    avgRecent: avg(recent.map(v => v.views)),
    avgShorts: avg(shorts.map(v => v.views)),
    avgLongs: avg(longs.map(v => v.views)),
    likeRate: (() => { const v = recent.reduce((a,x) => a+x.views, 0); return v ? recent.reduce((a,x) => a+x.likes, 0) / v * 100 : null; })(),
    top: [...recent].sort((a,b) => b.views - a.views)[0],
    trending: recent.filter(v => v.perHour != null && v.gained > 0).sort((a,b) => b.perHour - a.perHour).slice(0, 5),
    uploadsPerWeek: recent.length > 1 ? (recent.length - 1) / Math.max(1/7, (new Date(recent[0].published) - new Date(recent.at(-1).published)) / (7*DAY)) : null,
    lastUpload: recent[0]?.published
  };
}

function Delta({d}) {
  if (d == null) return null;
  if (!d) return <span className="delta flat">No change</span>;
  return <span className={'delta '+(d > 0 ? 'up' : 'down')}>{d > 0 ? '▲' : '▼'} {short(Math.abs(d))}</span>;
}

function Kpi({label, value, sub, delta}) {
  return <div className="kpi"><span className="kpi-label">{label}</span><strong className="kpi-value">{typeof value === 'string' ? <CountUp value={value}/> : value}</strong><span className="kpi-sub">{delta}{sub && <span>{sub}</span>}</span></div>;
}

// Smaller thumbnails: mqdefault (320w, 16:9) instead of the 480w hqdefault / larger originals; hqdefault only on high-DPI large slots.
// srcset lets the browser pick the smallest that is sharp at the displayed width and pixel density.
const ytId = t => /\/vi(?:_webp)?\/([\w-]{11})\//.exec(t ?? '')?.[1] ?? (/^[\w-]{11}$/.test(t ?? '') ? t : null);

function thumbProps(t, sizes = '(max-width:640px) 40vw, 240px') {
  const id = ytId(t);
  if (!id) return {src: t};
  const u = n => `https://i.ytimg.com/vi/${id}/${n}.jpg`;
  return {src: u('mqdefault'), srcSet: `${u('mqdefault')} 320w, ${u('hqdefault')} 480w`, sizes};
}

const avatarAt = (url, px) => url?.replace(/=s\d+/, '=s' + Math.round(px * Math.min(2, window.devicePixelRatio || 1)));

function Avatar({channel, size = 44}) {
  return channel.avatar
    ? <img decoding="async" loading="lazy" className="avatar" src={avatarAt(channel.avatar, size)} width={size} height={size} alt="" referrerPolicy="no-referrer"/>
    : <span className="avatar placeholder" style={{width:size, height:size, background:channel.color}}>{channel.name[0]}</span>;
}

function OutlierBadge({v, corner}) {
  return <span className={'outlier'+(corner ? ' corner' : '')+(v.score >= 5 ? ' big' : '')} title={`${fmt(v.views)} views vs a typical ${fmt(v.baseline)} for this channel's ${v.short ? 'Shorts' : 'long-form videos'} (median of ${v.peers})`}>▲ {v.score.toFixed(1)}× outlier</span>;
}

// Recent uploads as a strip of bars (oldest left, newest right), height = views. Bars are grey; outliers (well
// above the channel's usual for that type of video) take the channel colour. The dashed line is the average.
// Hover a bar for the video.
function UploadStrip({s}) {
  const vids = s.recent.slice(0, 16).reverse();
  if (!vids.length) return <div className="ustrip empty">No uploads loaded yet</div>;
  const max = Math.max(1, ...vids.map(v => v.views || 0));
  return <div className="ustrip" role="img" aria-label={`Views of the last ${vids.length} uploads, average ${short(s.avgRecent)}`}>
    {s.avgRecent ? <span className="ustrip-avg" style={{bottom:Math.min(100, s.avgRecent / max * 100)+'%'}} title={'Average '+short(s.avgRecent)+' views'}/> : null}
    {vids.map(v => <i key={v.id} className={v.outlier ? 'hot' : ''} style={{height:Math.max(4, (v.views || 0) / max * 100)+'%'}}
      title={`${v.title}
${fmt(v.views)} views · ${ago(v.published)}${v.short ? ' · Short' : ''}${v.score != null ? ' · '+v.score.toFixed(1)+'× usual' : ''}`}/>)}
  </div>;
}

// Progress from the last subscriber milestone passed to the next, as a small inline bar; the ETA is in the tooltip.
function Milestone({c}) {
  const p = projection(c), subs = c.subscribers ?? 0;
  if (!p.next) return <span/>;
  const prev = [0, ...MILESTONES].filter(m => m <= subs).at(-1);
  const pct = Math.max(0, Math.min(100, (subs - prev) / (p.next - prev) * 100));
  return <span className="ms" title={`${short(p.next - subs)} to go. ${p.eta ? 'At this pace: '+p.label : 'No subscriber growth measured lately.'}`}>
    <span className="ms-track"><i style={{width:pct+'%'}}/></span>{Math.floor(pct)}% to {short(p.next)}</span>;
}

function ChannelCard({c, open}) {
  const s = stats(c);
  return <button className="channel-card" onClick={() => open('ch:'+c.id)} style={{'--c':c.color}}>
    <div className="cc-head"><Avatar channel={c}/><div><strong>{c.title || c.name}</strong><span>{c.handle || c.path}</span></div><span className="chev">→</span></div>
    <div className="cc-stats">
      <div><span>Subscribers</span><strong>{short(c.subscribers)}</strong><Delta d={c.deltas.week?.s}/></div>
      <div><span>Total views</span><strong>{short(c.totalViews)}</strong><Delta d={c.deltas.week?.v}/></div>
      <div><span>Videos</span><strong>{fmt(c.videoCount)}</strong><Delta d={c.deltas.week?.n}/></div>
    </div>
    <UploadStrip s={s}/>
    <div className="cc-foot"><Milestone c={c}/><span>Last upload {ago(s.lastUpload)}</span></div>
    {c.error && <div className="cc-error">Last update failed: {c.error}</div>}
  </button>;
}

function ComparisonTable({channels, open}) {
  return <div className="table-wrap"><table>
    <thead><tr><th>Channel</th><th>Subscribers</th><th>Subs, 7 days</th><th>Total views</th><th>Views, 7 days</th><th>Videos</th><th>Avg views / video</th><th>Avg views (last 15)</th><th>Uploads / week</th><th>Shorts share</th><th>Outliers</th><th>Last upload</th></tr></thead>
    <tbody>{channels.map(c => { const s = stats(c); return <tr key={c.id} onClick={() => open('ch:'+c.id)} className={'clickable'+(c.kind === 'own' ? ' own' : '')}>
      <td><span className="dot" style={{background:c.color}}/>{c.name}{c.kind === 'own' && <span className="pill">You</span>}</td>
      <td>{fmt(c.subscribers)}</td><td><Delta d={c.deltas.week?.s}/>{c.deltas.week ? '' : <span className="muted">—</span>}</td>
      <td>{fmt(c.totalViews)}</td><td><Delta d={c.deltas.week?.v}/>{c.deltas.week ? '' : <span className="muted">—</span>}</td>
      <td>{fmt(c.videoCount)}</td><td>{fmt(s.avgLifetime)}</td><td>{fmt(s.avgRecent)}</td>
      <td>{s.uploadsPerWeek == null ? '—' : s.uploadsPerWeek.toFixed(1)}</td>
      <td>{s.recent.length ? Math.round(s.shorts.length/s.recent.length*100)+'%' : '—'}</td><td>{s.recent.filter(v => v.outlier).length} / {s.recent.length}</td><td>{ago(s.lastUpload)}</td>
    </tr>; })}</tbody>
  </table></div>;
}

function VideoList({videos, rate, score}) {
  return <div className="list">{videos.map(v => <a className="list-row" key={v.id} href={'https://www.youtube.com/'+(v.short ? 'shorts/' : 'watch?v=')+v.id} target="_blank" rel="noreferrer">
    <img decoding="async" {...thumbProps(v.thumbnail)} alt="" loading="lazy" referrerPolicy="no-referrer"/>
    <div className="list-main"><span className="video-title">{v.title}</span><span className="video-meta"><span className="dot" style={{background:v.ch.color}}/>{v.ch.name} · {ago(v.published)}{v.short ? ' · Short' : ''}</span>{v.outlier && !score && <span><OutlierBadge v={v}/></span>}</div>
    <div className="list-num">{score ? <><strong className="out-text">{v.score.toFixed(1)}×</strong><span>{fmt(v.views)} views</span></> : rate ? <><strong>+{short(v.perHour)}</strong><span>views / hour</span></> : <><strong>{fmt(v.views)}</strong><span>views</span></>}</div>
  </a>)}{!videos.length && <p className="muted">No uploads loaded yet.</p>}</div>;
}

function OutlierCard({channels, title, note}) {
  const list = channels.flatMap(c => c.outliers.map(v => ({...v, ch:c}))).sort((a,b) => b.score - a.score).slice(0, 8);
  return <section className="card">
    <div className="card-head"><div><h2>{title}</h2><span className="muted">{note}</span></div></div>
    {list.length ? <VideoList videos={list} score/> : <div className="spark-empty">No outliers yet. A video is flagged when it gets at least 2× the views of that channel's typical video of the same format.</div>}
  </section>;
}

// ---------- shared analytics helpers ----------
const median = list => { if (!list.length) return null; const a = [...list].sort((x,y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m-1] + a[m]) / 2; };

const STOP = new Set('the and for with you your this that from are was what how why best top new vs our its all can get not but has have will just more most only into than then them they who which when out over under below about after before also any here there very much many video videos official review reviews 2024 2025 2026 2027 buy should must watch dont'.split(' '));

const words = title => [...new Set((title ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9₹ ]+/g, ' ').split(/\s+/).filter(w => (w.length >= 3 || /\d{3,}/.test(w)) && !STOP.has(w)))];

const MILESTONES = [1e3, 5e3, 1e4, 25e3, 5e4, 1e5, 25e4, 5e5, 1e6, 2e6, 5e6, 1e7, 2e7, 5e7, 1e8];

function projection(c) {
  const d = c.deltas.month ?? c.deltas.week ?? c.deltas.day;
  const next = MILESTONES.find(m => m > (c.subscribers ?? 0));
  if (!d || !next) return {next, label:'Not enough growth data yet'};
  const days = (Date.now() - new Date(d.since)) / DAY;
  const rate = days >= 0.5 ? d.s / days : 0;
  if (rate <= 0) return {next, rate, label:'No subscriber growth measured yet'};
  const eta = (next - c.subscribers) / rate;
  const when = new Date(Date.now() + eta*DAY);
  return {next, rate, eta, when, label:`${short(next)} in ~${eta < 60 ? Math.ceil(eta)+' days' : Math.round(eta/30)+' months'} (${when.toLocaleDateString('en-IN', {month:'short', year:'numeric'})})`};
}

function ChannelSelect({channels, value, onChange, all = true}) {
  return <select value={value} onChange={e => onChange(e.target.value)} aria-label="Channel">
    {all && <option value="own">All your channels</option>}
    <optgroup label="Your channels">{channels.filter(c => c.kind === 'own').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
    {channels.some(c => c.kind === 'competitor') && <optgroup label="Competitors">{channels.filter(c => c.kind === 'competitor').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>}
  </select>;
}

function ScoreChip({v}) {
  return v.score == null ? null : <span className={'chip '+(v.outlier ? 'chip-hot' : v.score < 0.5 ? 'chip-low' : '')}>{v.score.toFixed(1)}× avg</span>;
}

// ---------- launch tracker ----------
function LaunchTracker({channels, title = 'Launch tracker', note}) {
  const all = channels.flatMap(c => c.launches.map(l => ({...l, ch:c}))).sort((a,b) => a.age - b.age);
  const [more, setMore] = useState(false);
  const list = more ? all : all.slice(0, 5);
  return <section className="card">
    <div className="card-head"><div><h2>{title}</h2><span className="muted">{note ?? 'Uploads from the last 72 hours vs the channel’s usual pace at the same age'}</span></div></div>
    {list.length ? <div className="list">{list.map(l => <a className="list-row" key={l.id} href={'https://www.youtube.com/'+(l.short ? 'shorts/' : 'watch?v=')+l.id} target="_blank" rel="noreferrer">
      <img decoding="async" {...thumbProps(l.thumbnail)} alt="" loading="lazy" referrerPolicy="no-referrer"/>
      <div className="list-main"><span className="video-title">{l.title}</span>
        <span className="video-meta"><span className="dot" style={{background:l.ch.color}}/>{l.ch.name} · {Math.round(l.age)}h old · {short(l.views)} views{l.expected ? ' · usual '+short(l.expected) : ''}</span>
        {l.checkpoints.some(p => p.views != null) && <span className="checkpoints">{l.checkpoints.filter(p => p.views != null).map(p => <span key={p.age} className="chip">{p.age}h: {short(p.views)}{p.expected ? ' / '+short(p.expected) : ''}</span>)}</span>}
      </div>
      <div className="list-num">{l.pace ? <><strong className={l.pace >= 1.2 ? 'up-text' : l.pace < 0.8 ? 'down-text' : ''}>{l.pace.toFixed(1)}×</strong><span>{l.pace >= 1.2 ? 'ahead of pace' : l.pace < 0.8 ? 'behind pace' : 'on pace'}</span></> : <><strong>—</strong><span>building baseline</span></>}</div>
    </a>)}</div> : <div className="spark-empty">No uploads in the last 72 hours.</div>}
    {all.length > 5 && <button className="link-btn show-more" onClick={() => setMore(m => !m)}>{more ? 'Show less' : 'Show all '+all.length+' uploads'}</button>}
  </section>;
}

// ---------- alerts ----------
const ALERT_ICON = {outlier:'▲', upload:'●', milestone:'★', published:'✓', ranking:'#', system:'!'};

function AlertList({alerts, channels}) {
  if (!alerts.length) return <div className="spark-empty">No alerts yet. You’ll see outliers, milestones, competitor uploads and published plans here.</div>;
  return <div className="list">{alerts.map(a => { const c = channels.find(x => x.id === a.channel); return <div className={'alert-row'+(a.read ? '' : ' unread')} key={a.id}>
    <span className={'alert-icon k-'+a.kind} style={{'--c':c?.color}}>{ALERT_ICON[a.kind] ?? '•'}</span>
    <div className="list-main"><strong>{a.title}</strong>{a.body && <span className="video-meta">{a.video ? <a href={'https://youtu.be/'+a.video} target="_blank" rel="noreferrer">{a.body}</a> : a.body}</span>}</div>
    <span className="muted small">{ago(a.ts)}</span>
  </div>; })}</div>;
}

// ---------- small persisted preferences ----------
const pref = (k, d) => { try { const v = localStorage.getItem('ytd.'+k); return v == null ? d : JSON.parse(v); } catch { return d; } };

const setPref = (k, v) => { try { localStorage.setItem('ytd.'+k, JSON.stringify(v)); } catch {} };

function usePref(k, d) {
  const [v, set] = useState(() => pref(k, d));
  return [v, x => { set(x); setPref(k, x); }];
}

const applyDensity = on => document.documentElement.classList.toggle('compact', !!on);

// ---------- database health ----------
const mb = n => n == null ? '—' : n >= 1e9 ? +(n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB';

const agoS = d => { if (!d) return '—'; const s = (Date.now() - new Date(d)) / 1000; return s < 60 ? Math.max(1, Math.round(s)) + 's ago' : ago(d); };

// ---------- resilient API client ----------
class ApiError extends Error {
  constructor(message, kind, status) { super(message); this.kind = kind; this.status = status; }
  get retryable() { return this.kind !== 'http' || this.status >= 500; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function once(path, options) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new ApiError('You are offline. Check your internet connection.', 'offline');
  const long = options.method && options.method !== 'GET';
  let response;
  try { response = await nodeFetch(path, {...options, headers:{'Content-Type':'application/json'}, signal:AbortSignal.timeout(long ? 180000 : 30000)}); }
  catch (err) {
    if (err.auth) throw new ApiError(err.message, 'auth');
    if (err.name === 'TimeoutError') throw new ApiError('The request timed out.', 'timeout');
    if (REMOTE) throw new ApiError(err.message && !/fetch/i.test(err.message) ? err.message : 'Can’t reach any of your nodes. Is one of the PCs on?', 'server');
    throw new ApiError(navigator.onLine === false ? 'You are offline. Check your internet connection.' : 'Can’t reach the dashboard server. Is npm run dev still running?', navigator.onLine === false ? 'offline' : 'server');
  }
  if (!(response.headers.get('content-type') || '').includes('json')) throw new ApiError('The dashboard server is not responding. Start it with npm run dev.', 'server', response.status);
  const data = await response.json().catch(() => { throw new ApiError('The server sent an unreadable response.', 'server', response.status); });
  if (!response.ok) throw new ApiError(data.error || 'Request failed.', response.status >= 500 ? 'server' : 'http', response.status);
  return data;
}

// GETs retry with backoff; writes are never repeated automatically.
async function api(path, options = {}) {
  const tries = !options.method || options.method === 'GET' ? 3 : 1;
  for (let i = 0; ; i++) {
    try { return await once(path, options); }
    catch (err) { if (i + 1 >= tries || !err.retryable || err.kind === 'offline') throw err; await sleep(800 * 2 ** i); }
  }
}

// ---------- toasts ----------
let pushToast = null;

function toast(text, {kind = 'info', action, ttl = 5000} = {}) { pushToast?.({text, kind, action, ttl}); }

function ToastHost() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    pushToast = t => setItems(list => list.some(x => x.text === t.text) ? list : [...list.slice(-3), {...t, id:Math.random()}]);
    return () => { pushToast = null; };
  }, []);
  const close = id => setItems(list => list.map(x => x.id === id ? {...x, leaving:true} : x));
  const gone = id => setItems(list => list.filter(x => x.id !== id || !x.leaving));
  return <div className="toasts" role="status" aria-live="polite">{items.map(t => <Toast key={t.id} t={t} close={() => close(t.id)} gone={() => gone(t.id)}/>)}</div>;
}

function Toast({t, close, gone}) {
  const [hover, setHover] = useState(false);
  useEffect(() => { if (hover || t.leaving || !t.ttl) return; const id = setTimeout(close, t.ttl); return () => clearTimeout(id); }, [hover, t.leaving]);
  return <div className={'toast '+t.kind+(t.leaving ? ' leaving' : '')} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onAnimationEnd={() => t.leaving && gone()}>
    <span className="toast-dot"/><span className="toast-text">{t.text}</span>
    {t.action && <button className="link-btn" onClick={() => { close(); t.action.run(); }}>{t.action.label}</button>}
    <button className="toast-x" onClick={close} aria-label="Dismiss">×</button>
  </div>;
}

// ---------- skeletons ----------
const Sk = ({w = '100%', h = 12, r = 6, style}) => <span className="sk" style={{width:w, height:h, borderRadius:r, ...style}}/>;

function PageSkeleton() {
  return <div className="skeleton" aria-busy="true" aria-label="Loading">
    <div className="kpi-grid">{[0,1,2,3].map(i => <div key={i} className="kpi"><Sk w="40%" h={10}/><Sk w="65%" h={26} style={{margin:'10px 0 8px'}}/><Sk w="50%" h={10}/></div>)}</div>
    <div className="sk-cards">{[0,1,2].map(i => <div key={i} className="card"><div className="row"><Sk w={40} h={40} r={20}/><div style={{flex:1, display:'grid', gap:8}}><Sk w="50%" h={14}/><Sk w="30%" h={10}/></div></div>
      <Sk h={70} r={10} style={{marginTop:18}}/><div style={{display:'grid', gap:8, marginTop:16}}>{[0,1,2].map(j => <Sk key={j} w={90-j*15+'%'} h={10}/>)}</div></div>)}</div>
    <div className="card" style={{display:'grid', gap:12}}>{[0,1,2,3,4].map(i => <div key={i} className="row"><Sk w={96} h={54} r={8}/><div style={{flex:1, display:'grid', gap:8}}><Sk w="70%" h={12}/><Sk w="35%" h={10}/></div></div>)}</div>
  </div>;
}

// ---------- animated number (restarts from the current value, so it can be interrupted) ----------
const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function CountUp({value}) {
  const m = typeof value === 'string' && value.match(/^([^\d-]*)(-?[\d,]*\.?\d+)(.*)$/);
  const target = m ? Number(m[2].replace(/,/g, '')) : NaN;
  const [shown, setShown] = useState(target);
  const cur = React.useRef(target);
  useEffect(() => {
    if (!Number.isFinite(target) || reduceMotion()) { cur.current = target; setShown(target); return; }
    const from = Number.isFinite(cur.current) ? cur.current : 0, t0 = performance.now(), dur = 600;
    let raf;
    const step = now => { const p = Math.min(1, (now - t0) / dur), v = from + (target - from) * (1 - (1 - p) ** 3); cur.current = v; setShown(v); if (p < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  if (!m) return value;
  const dec = (m[2].split('.')[1] || '').length, grouped = m[2].includes(',');
  return m[1] + Number(shown).toLocaleString('en-US', {minimumFractionDigits:dec, maximumFractionDigits:dec, useGrouping:grouped}) + m[3];
}

// ---------- confirm dialog ----------
let openConfirm = null;

const ask = (message, action = 'Delete') => new Promise(resolve => openConfirm ? openConfirm({message, action, resolve}) : resolve(window.confirm(message)));

function ConfirmHost() {
  const [req, setReq] = useState(null);
  useEffect(() => { openConfirm = setReq; return () => { openConfirm = null; }; }, []);
  const done = ok => { req.resolve(ok); setReq(null); };
  useEffect(() => { if (!req) return; const k = e => e.key === 'Escape' && done(false); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [req]);
  if (!req) return null;
  return <div className="modal-back" onClick={() => done(false)}>
    <div className="modal" role="alertdialog" aria-modal="true" aria-label={req.message} onClick={e => e.stopPropagation()}>
      <p>{req.message}</p>
      <div className="row end"><button className="btn" onClick={() => done(false)} autoFocus>Cancel</button><button className="btn danger-solid" onClick={() => done(true)}>{req.action}</button></div>
    </div>
  </div>;
}

const shortDate = d => { const t = new Date(d); return t.toLocaleDateString('en-IN', {day:'numeric', month:'short', ...(t.getFullYear() !== new Date().getFullYear() && {year:'2-digit'})}); };

const fresh = d => { const days = (Date.now() - new Date(d)) / 864e5; return days < 14 ? 'new' : days < 90 ? '' : 'old'; };

const yt = id => 'https://youtu.be/'+id;

const SERVICE_INFO = {
  discord: {name:'Discord', color:'#5865f2', how:'Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL'},
  slack: {name:'Slack', color:'#e01e5a', how:'api.slack.com/apps → Create App → Incoming Webhooks → Add New Webhook to Workspace → Copy'}
};

export {AlertList, Avatar, ChannelCard, ChannelSelect, ComparisonTable, ConfirmHost, DAY, Delta, Kpi, LaunchTracker, OutlierBadge, OutlierCard, PageSkeleton, SERVICE_INFO, ScoreChip, ToastHost, VideoList, ago, agoS, api, applyDensity, ask, avatarAt, avg, duration, fmt, fresh, key, mb, median, pref, projection, reduceMotion, setPref, short, shortDate, stats, thumbProps, toast, today, usePref, words, yt};
