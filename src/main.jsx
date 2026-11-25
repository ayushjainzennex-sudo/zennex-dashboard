import React, {useState, useEffect, useMemo} from 'react';
import {createRoot} from 'react-dom/client';
import '@fontsource-variable/inter';
import './style.css';
import {REMOTE, nodeFetch, onChange, state as remoteState, signIn, signOut, refreshNodes} from './remote.js';

const key = 'youtube-dashboard-v1';
const statuses = ['Idea','In production','Scheduled','Published'];
const formats = ['Long-form','Short'];
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

function loadPlanner() {
  try { const saved = JSON.parse(localStorage.getItem(key)); return Array.isArray(saved?.videos) ? saved.videos : []; }
  catch { return []; }
}


function videoId(value) {
  if (/^[\w-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value.includes('://') ? value : 'https://'+value);
    if (url.hostname === 'youtu.be') return url.pathname.split('/')[1];
    if (['youtube.com','www.youtube.com','m.youtube.com'].includes(url.hostname)) {
      const [, route, id] = url.pathname.split('/');
      if (route === 'watch') return url.searchParams.get('v');
      if (['shorts','live','embed'].includes(route)) return id;
    }
  } catch { return ''; }
  return '';
}

async function fetchVideo(id) {
  let apiError;
  try {
    const response = await nodeFetch('/api/video?id='+encodeURIComponent(id), {signal:AbortSignal.timeout(20000)});
    if ((response.headers.get('content-type') || '').includes('json')) {
      const data = await response.json();
      if (response.ok) return data;
      apiError = data.error;
    }
  } catch (err) { if (err.name === 'TimeoutError') apiError = 'The lookup timed out.'; }
  const response = await fetch('https://www.youtube.com/oembed?format=json&url='+encodeURIComponent('https://www.youtube.com/watch?v='+id), {signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(apiError || 'Video details could not be retrieved. Check that the video is public.');
  const data = await response.json();
  return {id, title:data.title, channel:data.author_name, thumbnail:data.thumbnail_url, partial:true};
}

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

function Sparkline({points, color, label}) {
  if (points.length < 2) return <div className="spark-empty">Growth tracking started. The chart fills in as the dashboard refreshes on later days.</div>;
  const w = 560, h = 120, pad = 6;
  const ys = points.map(p => p.y), min = Math.min(...ys), max = Math.max(...ys), span = max - min || 1;
  const xy = points.map((p,i) => [pad + i*(w-2*pad)/(points.length-1), h - pad - (p.y-min)/span*(h-2*pad)]);
  const line = xy.map(([x,y],i) => (i ? 'L' : 'M')+x.toFixed(1)+' '+y.toFixed(1)).join(' ');
  return <figure className="spark">
    <figcaption><span>{label}</span><span>{points[0].x} → {points.at(-1).x}</span></figcaption>
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label+' trend'}>
      <path className="spark-area" d={line+` L${xy.at(-1)[0]} ${h} L${xy[0][0]} ${h} Z`} fill={color} opacity=".12"/>
      <path className="spark-line" d={line} fill="none" stroke={color} strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round"/>
    </svg>
  </figure>;
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

function VideoCard({v}) {
  const url = 'https://www.youtube.com/'+(v.short ? 'shorts/' : 'watch?v=')+v.id;
  return <a className="video" href={url} target="_blank" rel="noreferrer">
    <div className="thumb"><img decoding="async" {...thumbProps(v.thumbnail)} alt="" loading="lazy" referrerPolicy="no-referrer"/>{v.short && <span className="tag">Short</span>}{v.outlier && <OutlierBadge v={v} corner/>}</div>
    <div className="video-body">
      <span className="video-title">{v.title}</span>
      <span className="video-meta"><strong>{short(v.views)}</strong> views · {ago(v.published)}</span>
      <div className="chips">
        {v.score != null && <span className={'chip '+(v.outlier ? 'chip-hot' : v.score < 0.5 ? 'chip-low' : '')} title={`${v.score.toFixed(2)}× this channel's typical ${v.short ? 'Short' : 'long-form video'} (${fmt(v.baseline)} views)`}>{v.score.toFixed(1)}× avg</span>}
        {v.views > 0 && <span className="chip" title={fmt(v.likes)+' likes'}>♥ {(v.likes/v.views*100).toFixed(1)}%</span>}
        {v.gained > 0 && <span className="chip chip-up" title={'Views gained in the last '+(v.window >= 23 ? '24 hours' : Math.round(v.window)+' hours')}>+{short(v.gained)} / {v.window >= 23 ? '24h' : Math.round(v.window)+'h'}</span>}
      </div>
    </div>
  </a>;
}

function ChannelCard({c, open, maxViews}) {
  const s = stats(c);
  return <button className="channel-card" onClick={() => open('ch:'+c.id)} style={{'--c':c.color}}>
    <div className="cc-head"><Avatar channel={c}/><div><strong>{c.title || c.name}</strong><span>{c.handle || c.path}</span></div><span className="chev">→</span></div>
    <div className="cc-stats">
      <div><span>Subscribers</span><strong>{short(c.subscribers)}</strong><Delta d={c.deltas.week?.s}/></div>
      <div><span>Total views</span><strong>{short(c.totalViews)}</strong><Delta d={c.deltas.week?.v}/></div>
      <div><span>Videos</span><strong>{fmt(c.videoCount)}</strong><Delta d={c.deltas.week?.n}/></div>
    </div>
    <div className="share"><div style={{width:((c.totalViews||0)/maxViews*100)+'%'}}/></div>
    <div className="cc-foot"><span>Next: {projection(c).label}</span><span>Last upload {ago(s.lastUpload)}</span></div>
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
        <button className="btn primary" onClick={onRefresh} disabled={st.running}>{st.running ? <span className="spinner"/> : 'Update now'}</button>
        <button className="btn" onClick={() => open('rankings')}>Rankings</button>
        <button className="btn" onClick={onSearch}>Search <kbd>Ctrl K</kbd></button>
        <button className="btn" onClick={() => open('competitors:'+own[0]?.id)}>Add competitor</button>
      </div>
    </section>
  </aside>;
}

function Overview({own, open, rail}) {
  const total = f => own.reduce((s,c) => s + (c[f] || 0), 0);
  const totalDelta = f => own.some(c => c.deltas.week) ? own.reduce((s,c) => s + (c.deltas.week?.[f] || 0), 0) : null;
  const maxViews = Math.max(1, ...own.map(c => c.totalViews || 0));
  const latest = own.flatMap(c => c.recent.map(v => ({...v, ch:c}))).sort((a,b) => new Date(b.published) - new Date(a.published)).slice(0, 8);
  const trending = own.flatMap(c => stats(c).trending.map(v => ({...v, ch:c}))).sort((a,b) => b.perHour - a.perHour).slice(0, 5);
  const weekUploads = own.reduce((s,c) => s + (c.periods?.[0]?.uploads ?? c.recent.filter(v => Date.now() - new Date(v.published) < 7*DAY).length), 0);
  const weekViews = own.reduce((s,c) => s + (c.periods?.[0]?.uploadViews ?? 0), 0);
  return <div className="ov-layout"><div className="ov-main">
    <section className="kpis">
      <Kpi label="Total subscribers" value={short(total('subscribers'))} delta={<Delta d={totalDelta('s')}/>} sub={`all ${own.length} channels · change over 7 days`}/>
      <Kpi label="Total views" value={short(total('totalViews'))} delta={<Delta d={totalDelta('v')}/>} sub="lifetime · change over 7 days"/>
      <Kpi label="Videos published" value={fmt(total('videoCount'))} sub="lifetime"/>
      <Kpi label="Uploads, last 7 days" value={fmt(weekUploads)} sub={short(weekViews)+' views on them so far'}/>
    </section>
    <section className="channel-cards">{own.map(c => <ChannelCard key={c.id} c={c} open={open} maxViews={maxViews}/>)}</section>
    <div className="split">
      <section className="card">
        <div className="card-head"><h2>Latest uploads</h2><span className="muted">All channels</span></div>
        <VideoList videos={latest}/>
      </section>
      <section className="card">
        <div className="card-head"><h2>Trending now</h2><span className="muted">Fastest-growing recent videos</span></div>
        {trending.length ? <VideoList videos={trending} rate/> : <div className="spark-empty">Trends appear after the next hourly update compares view counts.</div>}
      </section>
    </div>
    <LaunchTracker channels={own}/>
    <OutlierCard channels={own} title="Outliers" note="Videos beating their own channel's typical views (Shorts and long-form compared separately)"/>
    <section className="card">
      <div className="card-head"><h2>Channel comparison</h2></div>
      <ComparisonTable channels={own} open={open}/>
    </section>
  </div>{rail}</div>;
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

// Stats for a channel opened from search that you don't track. Served from a cache (refreshed after 4 hours).
function LookupPage({channelId, own, onTrack, onTracked}) {
  const [d, setD] = useState(null), [err, setErr] = useState(''), [adding, setAdding] = useState(null);
  const load = () => { setErr(''); api('/api/lookup/'+channelId).then(x => x.tracked ? onTracked(x.tracked) : setD(x)).catch(e => setErr(e.message)); };
  useEffect(load, [channelId]);
  if (err) return <div className="card"><p className="error" role="alert">{err}</p><button className="btn" onClick={load}>Retry</button></div>;
  if (!d) return <PageSkeleton/>;
  const track = async o => { setAdding(o.id); try { await onTrack(d.handle ?? d.channelId, o.id); toast(`${d.title} added as a competitor of ${o.name}.`, {kind:'ok'}); } catch (e) { toast(e.message, {kind:'error'}); } finally { setAdding(null); } };
  return <>
    <section className="hero">
      {d.avatar && <img className="avatar" src={avatarAt(d.avatar, 84)} width="84" height="84" alt="" referrerPolicy="no-referrer" style={{borderRadius:'50%'}}/>}
      <div className="hero-text">
        <h1>{d.title}<span className="pill">Not tracked</span></h1>
        <p className="muted">{[d.handle, d.country, d.joined && 'Joined '+d.joined, 'Updated '+ago(d.fetchedAt)].filter(Boolean).join(' · ')}</p>
        {d.description && <p className="desc">{d.description}</p>}
      </div>
      <div className="row wrap">
        <a className="btn" href={'https://www.youtube.com/'+(d.handle ?? 'channel/'+d.channelId)} target="_blank" rel="noreferrer">Open on YouTube ↗</a>
        {own.map(o => <button key={o.id} className="btn" disabled={adding != null} onClick={() => track(o)}>{adding === o.id ? <span className="spinner"/> : '+ Rival of '+o.name}</button>)}
      </div>
    </section>
    {d.stale && <div className="notice">Couldn’t refresh ({d.stale}). Showing the copy from {ago(d.fetchedAt)}.</div>}
    <section className="kpis">
      <Kpi label="Subscribers" value={short(d.subscribers)} sub="public, rounded"/>
      <Kpi label="Total views" value={short(d.totalViews)} sub="lifetime"/>
      <Kpi label="Videos" value={fmt(d.videoCount)} sub="lifetime"/>
      <Kpi label="Avg views, recent" value={d.recent.length ? short(d.recent.reduce((t, v) => t + (v.views ?? 0), 0) / d.recent.length) : '—'} sub={'last '+d.recent.length+' uploads'}/>
    </section>
    <section className="periods">{d.periods.map(p => <div className="period" key={p.key}>
      <span className="kpi-label">{p.label}</span>
      {[['Long videos', p.long], ['Shorts', p.short]].map(([name, x]) => <div className="period-row" key={name}>
        <div><strong>{short(x.views)}</strong><span className="muted small">{name} · views</span></div>
        <div><strong>{x.n}{name === 'Shorts' && p.shortsPartial ? '+' : ''}</strong><span className="muted small">{name} · uploads</span></div></div>)}
      {p.shortsPartial && <span className="muted small">Shorts counted back to {shortDate(d.feedOldest)}</span>}
    </div>)}</section>
    <section className="card">
      <div className="card-head"><h2>Recent uploads</h2><span className="muted small">Dates marked ~ are approximate</span></div>
      <div className="lookup-list">{d.recent.map(v => <a key={v.id} className="lookup-row" href={'https://youtu.be/'+v.id} target="_blank" rel="noreferrer">
        <img {...thumbProps(v.id, '96px')} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"/>
        <span className="lr-title">{v.title}{v.short && <span className="pill">Short</span>}</span>
        <span className="muted small">{v.views != null ? short(v.views)+' views' : ''}</span>
        <span className="muted small">{v.approx ? '~' : ''}{shortDate(v.published)}</span></a>)}</div>
    </section>
  </>;
}

// Keyword search inside one channel, with metrics per video and for the whole result set.
const COLS = [
  ['published', 'Posted'], ['views', 'Views'], ['perDay', 'Views/day'], ['score', 'vs typical'], ['gained24h', 'Last 24h'], ['likeRate', 'Like rate'], ['seconds', 'Length']
];
// Expanded view of one video: large thumbnail (plays inline), every metric, and views over time when tracked.
function VideoBigView({v, typical, channel}) {
  const [h, setH] = useState(null), [play, setPlay] = useState(false), [w, setW] = useState(null);
  // The table scrolls sideways; keep this panel the width of the visible area and pinned to its left edge.
  const box = React.useCallback(el => {
    const wrap = el?.closest('.table-wrap'); if (!wrap) return;
    const ro = new ResizeObserver(() => setW(wrap.clientWidth)); ro.observe(wrap); setW(wrap.clientWidth);
  }, []);
  useEffect(() => { let live = true; api(`/api/videos/${v.id}/history`).then(x => live && setH(x)).catch(() => live && setH({points: []})); return () => { live = false; }; }, [v.id]);
  const pts = (h?.points ?? []).map(p => ({t: Date.parse(p.ts), y: p.views}));
  const published = h?.video?.published ?? v.published, exact = h?.video?.exact ?? v.exact;
  const ageDays = published ? (Date.now() - Date.parse(published)) / DAY : null;
  const likes = h?.video?.likes ?? v.likes, views = v.views ?? h?.video?.views;
  const last = (hours) => { if (pts.length < 2) return null; const end = pts.at(-1), start = [...pts].reverse().find(p => p.t <= end.t - hours * 3600e3); return start ? end.y - start.y : null; };
  // Views per hour between snapshots, for the "momentum" readout.
  const rate = pts.length >= 2 ? (pts.at(-1).y - pts.at(-2).y) / Math.max((pts.at(-1).t - pts.at(-2).t) / 3600e3, 0.1) : null;
  const stat = (label, value, sub, cls = '') => <div className={'bv-stat '+cls}><span className="kpi-label">{label}</span><strong>{value}</strong>{sub && <span className="muted small">{sub}</span>}</div>;
  const since = pts.length >= 2 ? pts.at(-1).y - pts[0].y : null;
  return <div className={'bigview'+(w && w < 900 ? ' narrow' : '')} ref={box} style={w ? {width: w} : undefined}>
    <div className="bv-media">
      {play ? <iframe src={`https://www.youtube-nocookie.com/embed/${v.id}?autoplay=1&rel=0`} title={v.title} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen/>
        : <button className="bv-thumb" onClick={() => setPlay(true)} aria-label={'Play '+v.title}>
            <img src={`https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`} srcSet={`https://i.ytimg.com/vi/${v.id}/hqdefault.jpg 480w, https://i.ytimg.com/vi/${v.id}/maxresdefault.jpg 1280w`} sizes="(max-width:820px) 100vw, 520px" alt="" decoding="async" referrerPolicy="no-referrer"/>
            <span className="bv-play" aria-hidden="true">▶</span>{v.seconds && <span className="bv-len">{duration(v.seconds)}</span>}</button>}
    </div>
    <div className="bv-info">
      <h3 className="bv-title">{v.title}</h3>
      <p className="muted small">{[channel.name, v.short ? 'Short' : 'Long video', published && (exact ? '' : '~') + new Date(published).toLocaleString('en-IN', {day:'numeric', month:'short', year:'numeric', ...(exact && {hour:'2-digit', minute:'2-digit'})}), v.age].filter(Boolean).join(' · ')}</p>
      <div className="bv-stats">
        {stat('Views', views == null ? '—' : fmt(views))}
        {stat('Views / day', v.perDay == null ? '—' : short(Math.round(v.perDay)), ageDays != null ? 'over '+(ageDays < 1 ? Math.round(ageDays * 24)+' h' : Math.round(ageDays)+' days') : '')}
        {stat('vs typical', v.score == null ? '—' : v.score.toFixed(1)+'×', typical ? 'typical '+short(typical) : '', v.score >= 2 ? 'up' : v.score != null && v.score < 0.5 ? 'down' : '')}
        {stat('Last 24h', last(24) != null ? '+'+short(last(24)) : v.gained24h != null ? '+'+short(v.gained24h) : '—', rate != null ? '~'+short(Math.round(rate))+'/hour now' : '')}
        {last(24 * 7) != null ? stat('Last 7 days', '+'+short(last(24 * 7))) : stat('Tracked gain', since != null ? '+'+short(since) : '—', pts.length ? 'since '+shortDate(pts[0].t) : 'not tracked')}
        {stat('Likes', likes == null ? '—' : short(likes), likes && views ? (likes / views * 100).toFixed(1)+'% like rate' : '')}
      </div>
      <div className="row wrap">
        <a className="btn primary" href={'https://youtu.be/'+v.id} target="_blank" rel="noreferrer">Open on YouTube ↗</a>
        {!play && <button className="btn" onClick={() => setPlay(true)}>Play here</button>}
        <button className="btn" onClick={() => { navigator.clipboard?.writeText('https://youtu.be/'+v.id); toast('Link copied.', {kind:'ok'}); }}>Copy link</button>
      </div>
    </div>
    <div className="bv-chart">
      {!h ? <div className="skeleton" style={{height:130}}/> : pts.length >= 2
        ? <Sparkline label="Views over time" color="var(--accent)" points={pts.map(p => ({x: new Date(p.t).toLocaleDateString('en-IN', {day:'numeric', month:'short'}), y: p.y}))}/>
        : <div className="spark-empty">{h.video ? 'Views over time will appear after the next few updates.' : 'This video isn’t tracked by the dashboard, so there’s no views history. Its current numbers come from YouTube.'}</div>}
    </div>
  </div>;
}

function ChannelSearch({c}) {
  const [q, setQ] = useState(''), [res, setRes] = useState(null), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const [type, setType] = useState('all'), [sort, setSort] = useState({k: 'relevance', dir: -1}), [open, setOpen] = useState(null);
  const run = async e => {
    e?.preventDefault();
    const term = q.trim(); if (term.length < 2) return;
    setBusy(true); setErr('');
    try { setRes(await api(`/api/channels/${c.id}/search?q=${encodeURIComponent(term)}`)); setType('all'); setSort({k:'relevance', dir:-1}); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const all = res?.videos ?? [];
  const list = all.filter(v => type === 'all' || (type === 'short') === v.short);
  const rows = sort.k === 'relevance' ? list : [...list].sort((a, b) => {
    const av = sort.k === 'published' ? Date.parse(a.published ?? 0) : a[sort.k], bv = sort.k === 'published' ? Date.parse(b.published ?? 0) : b[sort.k];
    return ((av ?? -Infinity) > (bv ?? -Infinity) ? 1 : (av ?? -Infinity) < (bv ?? -Infinity) ? -1 : 0) * sort.dir;
  });
  const views = list.map(v => v.views).filter(x => x != null);
  const med = arr => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m-1] + a[m]) / 2; };
  const best = list.reduce((b, v) => (v.views ?? -1) > (b?.views ?? -1) ? v : b, null);
  const recent = list.filter(v => v.published && Date.now() - Date.parse(v.published) < 30 * DAY);
  const hits = list.filter(v => v.score >= 2).length;
  const head = (k, l) => <th key={k} className={'num sortable'+(sort.k === k ? ' on' : '')} onClick={() => setSort(s => ({k, dir: s.k === k ? -s.dir : -1}))} aria-sort={sort.k === k ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none'}>
    {l}{sort.k === k && <span className="muted">{sort.dir < 0 ? ' ↓' : ' ↑'}</span>}</th>;
  return <section className="card csearch">
    <div className="card-head"><div><h2>Search this channel</h2><span className="muted">Find {c.name}’s videos for a keyword and compare how they perform</span></div></div>
    <form className="lookup" onSubmit={run}>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="e.g. laptop under 50000" aria-label={'Search '+c.name+' videos'}/>
      <button className="btn primary" disabled={busy || q.trim().length < 2}>{busy ? <span className="spinner"/> : 'Search'}</button>
    </form>
    {err && <p className="error" role="alert">{err}</p>}
    {busy && !res && <div className="skeleton" style={{height:120, marginTop:12}}/>}
    {res && <>
      <div className="cs-bar">
        <div className="seg sm" role="group" aria-label="Video type">{[['all','All '+all.length], ['long','Long '+all.filter(v => !v.short).length], ['short','Shorts '+all.filter(v => v.short).length]].map(([k, l]) => <button key={k} aria-pressed={type === k} onClick={() => setType(k)}>{l}</button>)}</div>
        <span className="muted small">“{res.q}” · {ago(res.at)} · click a column to sort{sort.k !== 'relevance' && <> · <a href="#" onClick={e => { e.preventDefault(); setSort({k:'relevance', dir:-1}); }}>back to YouTube order</a></>}</span>
      </div>
      {!list.length ? <div className="spark-empty">No {type === 'short' ? 'Shorts' : type === 'long' ? 'long videos' : 'videos'} for “{res.q}”.</div> : <>
      <div className="cs-metrics">
        <div><span className="kpi-label">Videos</span><strong>{list.length}</strong><span className="muted small">{recent.length} in the last 30 days</span></div>
        <div><span className="kpi-label">Total views</span><strong>{short(views.reduce((t, x) => t + x, 0))}</strong><span className="muted small">across these videos</span></div>
        <div><span className="kpi-label">Median views</span><strong>{short(med(views))}</strong><span className="muted small">channel typical {short(res.typical[type === 'short' ? 'short' : 'long'] ?? 0)}{type === 'all' ? ' (long)' : ''}</span></div>
        <div><span className="kpi-label">Median views/day</span><strong>{short(Math.round(med(list.map(v => v.perDay).filter(x => x != null)) ?? 0))}</strong><span className="muted small">since each was posted</span></div>
        <div><span className="kpi-label">Beat typical 2×+</span><strong>{hits}</strong><span className="muted small">{Math.round(hits / list.length * 100)}% of these videos</span></div>
        <div><span className="kpi-label">Best</span><strong>{short(best?.views ?? 0)}</strong><span className="muted small cs-best" title={best?.title}>{best?.title}</span></div>
      </div>
      <div className="table-wrap"><table className="cs-table">
        <thead><tr><th>Video</th>{COLS.map(([k, l]) => head(k, l))}</tr></thead>
        <tbody>{rows.map(v => <React.Fragment key={v.id}><tr className={'clickable'+(open === v.id ? ' open' : '')} onClick={() => setOpen(o => o === v.id ? null : v.id)} aria-expanded={open === v.id}>
          <td><a className="cs-video" href={'https://youtu.be/'+v.id} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>
            <img {...thumbProps(v.id, '96px')} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"/>
            <span className="cs-title">{v.title}{v.short && <span className="pill">Short</span>}</span></a></td>
          <td className="num" title={v.published ? new Date(v.published).toLocaleString('en-IN') : ''}>{v.published ? <>{v.exact ? '' : '~'}{shortDate(v.published)}</> : '—'}<div className="muted small">{v.age ?? ''}</div></td>
          <td className="num"><strong>{v.views == null ? '—' : fmt(v.views)}</strong></td>
          <td className="num">{v.perDay == null ? "—" : short(Math.round(v.perDay))}</td>
          <td className="num">{v.score == null ? '—' : <span className={'cs-score '+(v.score >= 2 ? 'up' : v.score < 0.5 ? 'down' : '')}>{v.score.toFixed(1)}×</span>}</td>
          <td className="num">{v.gained24h == null ? <span className="muted">—</span> : '+'+short(v.gained24h)}</td>
          <td className="num">{v.likeRate == null ? <span className="muted">—</span> : v.likeRate.toFixed(1)+'%'}</td>
          <td className="num muted">{v.seconds ? duration(v.seconds) : '—'}</td>
        </tr>
        {open === v.id && <tr className="cs-detail-tr"><td colSpan={COLS.length + 1}><VideoBigView v={v} typical={res.typical[v.short ? 'short' : 'long']} channel={c}/></td></tr>}
        </React.Fragment>)}</tbody>
      </table></div>
      <p className="muted small">vs typical = views ÷ this channel’s median for that type (long or Short). Last 24h and like rate are only known for videos the dashboard tracks. Dates with ~ are approximate.</p>
      </>}
    </>}
  </section>;
}

function ChannelPage({c, onRemove}) {
  const s = stats(c);
  const [sort, setSort] = useState('new');
  const [range, setRange] = usePref('range', 30);
  const hist = inRange(c.history, range);
  const points = f => hist.map(h => ({x:h.date, y:h[f]}));
  const gain = f => hist.length > 1 && hist.at(-1)[f] != null && hist[0][f] != null ? hist.at(-1)[f] - hist[0][f] : null;
  const videos = sort === 'new' ? s.recent : sort === 'views' ? [...s.recent].sort((a,b) => b.views - a.views) : sort === 'trend' ? [...s.recent].sort((a,b) => (b.perHour ?? -1) - (a.perHour ?? -1)) : [...s.recent].sort((a,b) => (b.score ?? -1) - (a.score ?? -1));
  const wk = c.deltas.week, day = c.deltas.day;
  const since = d => d ? 'vs '+new Date(d.since).toLocaleDateString('en-IN', {day:'numeric', month:'short'}) : 'collecting data';
  return <>
    <section className="hero" style={{'--c':c.color}}>
      <Avatar channel={c} size={84}/>
      <div className="hero-text">
        <h1>{c.title || c.name}{c.kind === 'competitor' && <span className="pill">Competitor{c.rivalNames ? ' of '+c.rivalNames : ''}</span>}</h1>
        <p className="muted">{[c.handle || c.path, c.country, c.joined && 'Joined '+c.joined, c.trackingSince && 'Tracked since '+new Date(c.trackingSince).toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'})].filter(Boolean).join(' · ')}</p>
        {c.description && <p className="desc">{c.description}</p>}
      </div>
      <div className="row">
        <a className="btn" href={c.url} target="_blank" rel="noreferrer">Open on YouTube ↗</a>
        {onRemove && <button className="btn danger" onClick={onRemove}>Stop tracking</button>}
      </div>
    </section>
    {c.error && <div className="notice">Last update failed: {c.error}</div>}

    <section className="kpis six">
      <Kpi label="Subscribers" value={short(c.subscribers)} delta={<Delta d={wk?.s}/>} sub={since(wk)}/>
      <Kpi label="Total views" value={short(c.totalViews)} delta={<Delta d={wk?.v}/>} sub={since(wk)}/>
      <Kpi label="Views, last 24h" value={day ? short(day.v) : '—'} sub={day ? 'channel-wide' : 'collecting data'}/>
      <Kpi label="Videos" value={fmt(c.videoCount)} delta={<Delta d={wk?.n}/>} sub={since(wk)}/>
      <Kpi label="Avg views, recent" value={short(s.avgRecent)} sub={'last '+s.recent.length+' uploads'}/>
      <Kpi label="Like rate" value={s.likeRate == null ? '—' : s.likeRate.toFixed(1)+'%'} sub="likes ÷ views, recent"/>
    </section>
    <div className="projection"><span className="kpi-label">Next milestone</span><strong>{projection(c).label}</strong>{projection(c).rate > 0 && <span className="muted small">at ~{short(projection(c).rate)} subscribers/day</span>}</div>

    <section className="periods">{c.periods?.map(p => <div className="period" key={p.key}>
      <span className="kpi-label">{p.label}</span>
      <div className="period-total"><strong>{p.views == null ? '—' : short(p.views)}</strong>
        <span className="muted small">channel views{p.since ? ' since '+shortDate(p.since)+' (tracking start)' : ''}</span></div>
      <span className="muted small period-sub">Views on uploads from this period</span>
      {[['Long videos', p.long], ['Shorts', p.short]].map(([name, x]) => <div className="period-row" key={name}>
        <div><strong>{short(x?.views ?? 0)}</strong><span className="muted small">{name} · views</span></div>
        <div><strong>{x?.n ?? 0}</strong><span className="muted small">{name} · uploads</span></div></div>)}
    </div>)}</section>

    <ChannelSearch c={c}/>

    <LaunchTracker channels={[c]} note="This channel’s uploads from the last 72 hours vs its usual pace at the same age"/>
    <div className="split">
      <section className="card">
        <div className="card-head"><div><h2>Growth</h2><span className="muted">{gain('s') != null ? (gain('s') >= 0 ? '+' : '')+short(gain('s'))+' subs · +'+short(gain('v'))+' views in '+(range ? range+' days' : 'total') : 'Daily, from the database'}</span></div><RangeSeg value={range} onChange={setRange}/></div>
        <Sparkline points={points('s')} color={c.color} label="Subscribers"/>
        {points('v').length > 1 && <Sparkline points={points('v')} color={c.color} label="Total views"/>}
      </section>
      <section className="card">
        <div className="card-head"><h2>Content mix</h2><span className="muted">Last {s.recent.length} uploads</span></div>
        <div className="mix">
          <div className="mix-bar"><div style={{width:(s.recent.length ? s.shorts.length/s.recent.length*100 : 0)+'%', background:c.color}}/></div>
          <div className="mix-legend"><span><i style={{background:c.color}}/>Shorts · {s.shorts.length}</span><span><i/>Long-form · {s.longs.length}</span></div>
          <dl>
            <div><dt>Avg views, Shorts</dt><dd>{fmt(s.avgShorts)}</dd></div>
            <div><dt>Avg views, long-form</dt><dd>{fmt(s.avgLongs)}</dd></div>
            <div><dt>Uploads per week</dt><dd>{s.uploadsPerWeek == null ? '—' : s.uploadsPerWeek.toFixed(1)}</dd></div>
            <div><dt>Last upload</dt><dd>{ago(s.lastUpload)}</dd></div>
          </dl>
          {s.top && <div className="top"><span className="kpi-label">Top recent video</span><VideoCard v={s.top}/></div>}
        </div>
      </section>
    </div>

    <OutlierCard channels={[c]} title="Outliers on this channel" note={`Compared with this channel's last ${c.poolSize} stored videos, by format. The baseline widens as the database collects more uploads.`}/>
    <section className="card">
      <div className="card-head"><h2>Recent uploads</h2>
        <div className="seg" role="group" aria-label="Sort videos">{[['new','Newest'],['views','Most viewed'],['trend','Trending'],['outlier','Outlier score']].map(([k,l]) => <button key={k} aria-pressed={sort===k} onClick={() => setSort(k)}>{l}</button>)}</div>
      </div>
      <div className="video-grid">{videos.map(v => <VideoCard v={v} key={v.id}/>)}</div>
      {!videos.length && <p className="muted">No uploads loaded yet.</p>}
    </section>
  </>;
}

function Competitors({owner, own, competitors, open, onAdd, onUnlink, onPlan}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const maxViews = Math.max(1, ...competitors.map(c => c.totalViews || 0));
  async function add(event) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true); setError('');
    try { await onAdd(new FormData(form).get('input').trim()); form.reset(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <>
    <div className="toolbar">
      <div className="seg" role="tablist" aria-label="Your channel">{own.map(c => <button key={c.id} role="tab" aria-pressed={c.id === owner.id} onClick={() => open('competitors:'+c.id)}><span className="dot" style={{background:c.color}}/>{c.name} <span className="muted">{c.rivals}</span></button>)}</div>
    </div>
    <section className="card">
      <div className="card-head"><div><h2>Competitors of {owner.name}</h2><span className="muted">Channels in {owner.name}’s niche. Each is fetched now and updated every hour.</span></div></div>
      <form className="lookup" onSubmit={add}><input name="input" aria-label={'Competitor of '+owner.name} placeholder="@channelhandle or youtube.com/@channelhandle" required/><button className="btn primary" disabled={busy}>{busy ? <><span className="spinner"/>Fetching</> : '+ Add competitor'}</button></form>
      {error && <p className="error" role="alert">{error}</p>}
      {competitors.length > 0 && <div className="tags">{competitors.map(c => <span className="tag-chip" key={c.id}><Avatar channel={c} size={18}/>{c.name}<button aria-label={'Remove '+c.name+' from '+owner.name} title={'Remove from '+owner.name} onClick={() => onUnlink(c)}>×</button></span>)}</div>}
    </section>
    {competitors.length ? <>
      <section className="channel-cards">{competitors.map(c => <ChannelCard key={c.id} c={c} open={open} maxViews={maxViews}/>)}</section>
      <section className="card">
        <div className="card-head"><h2>{owner.name} vs competitors</h2><span className="muted">Ranked by subscribers</span></div>
        <ComparisonTable channels={[owner, ...competitors].sort((a,b) => (b.subscribers||0) - (a.subscribers||0))} open={open}/>
      </section>
      <HeadToHead key={owner.id} channels={[owner, ...competitors]}/>
      <div className="split"><UploadFeed competitors={competitors}/><OutlierCard channels={competitors} title="Competitor outliers" note="Their videos that beat their own typical views. Good topics to study."/></div>
      <TopicGaps own={[owner]} competitors={competitors} onPlan={p => onPlan({...p, channel:owner.id})}/>
    </> : <section className="card"><div className="spark-empty">No competitors for {owner.name} yet. Add a channel in the same niche above.</div></section>}
  </>;
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

function keywordStats(videos, min = 3) {
  const scored = videos.filter(v => v.score != null);
  const map = new Map();
  for (const v of scored) for (const w of words(v.title)) (map.get(w) ?? map.set(w, []).get(w)).push(v);
  return [...map.entries()].filter(([, list]) => list.length >= min && list.length <= scored.length * 0.6)
    .map(([word, list]) => ({word, count:list.length, score:median(list.map(v => v.score)), example:[...list].sort((a,b) => b.score - a.score)[0]}));
}

function priceBucket(title) {
  const m = /(?:under|below|within)\s*(?:rs\.?|₹)?\s*(\d[\d,.]*)\s*(k|lakh|lac|l)?\b/i.exec(title ?? '');
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ''));
  if (/^k$/i.test(m[2] ?? '')) n *= 1e3; else if (/^l/i.test(m[2] ?? '')) n *= 1e5;
  return [[10e3,'Under ₹10K'],[20e3,'₹10K–20K'],[40e3,'₹20K–40K'],[60e3,'₹40K–60K'],[1e5,'₹60K–1L'],[Infinity,'₹1L+']].find(([max]) => n <= max)[1];
}

const scoreColor = s => s == null ? 'var(--panel-2)' : `color-mix(in srgb, ${s >= 1 ? 'var(--up)' : 'var(--down)'} ${Math.min(85, Math.round(Math.abs(Math.log2(s)) * 45 + 8))}%, var(--panel-2))`;

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

// ---------- insights ----------
function Insights({channels}) {
  const [sel, setSel] = useState('own');
  const chosen = sel === 'own' ? channels.filter(c => c.kind === 'own') : channels.filter(c => String(c.id) === sel);
  const pool = chosen.flatMap(c => c.pool.map(v => ({...v, ch:c})));
  const dated = pool.filter(v => !v.approx && v.score != null && Date.now() - new Date(v.published) >= 3*DAY); // fresh uploads haven't caught up yet
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], blocks = ['12–4a','4–8a','8a–12','12–4p','4–8p','8p–12'];
  const cell = (d, b) => { const list = dated.filter(v => { const t = new Date(v.published); return (t.getDay()+6)%7 === d && Math.floor(t.getHours()/4) === b; }); return {n:list.length, s:median(list.map(v => v.score))}; };
  const kw = keywordStats(pool);
  const top = [...kw].sort((a,b) => b.score - a.score).slice(0, 10), weak = [...kw].sort((a,b) => a.score - b.score).slice(0, 5);
  const prices = Object.entries(pool.reduce((acc, v) => { const b = priceBucket(v.title); if (b && v.score != null) (acc[b] ??= []).push(v.score); return acc; }, {}));
  const order = ['Under ₹10K','₹10K–20K','₹20K–40K','₹40K–60K','₹60K–1L','₹1L+'];
  const fmtMix = ['Long-form','Shorts'].map(f => { const list = pool.filter(v => (f === 'Shorts') === v.short && v.score != null); return {f, n:list.length, views:median(list.map(v => v.views))}; });
  return <>
    <div className="toolbar"><ChannelSelect channels={channels} value={sel} onChange={setSel}/><span className="muted small">Based on {pool.length} stored videos. Scores compare each video with its own channel’s typical views.</span></div>
    <div className="split">
      <section className="card">
        <div className="card-head"><div><h2>Best time to post</h2><span className="muted">Median performance by upload day and time (your local time)</span></div></div>
        <div className="heat">
          <span/>{blocks.map(b => <span key={b} className="heat-x">{b}</span>)}
          {days.map((d, di) => <React.Fragment key={d}><span className="heat-y">{d}</span>{blocks.map((b, bi) => { const c = cell(di, bi); return <span key={b} className="heat-cell" style={{background:scoreColor(c.s)}} title={c.n ? `${c.n} video${c.n > 1 ? 's' : ''} · ${c.s.toFixed(2)}× typical` : 'No uploads'}>{c.n ? c.s.toFixed(1)+'×' : ''}</span>; })}</React.Fragment>)}
        </div>
        <p className="muted small">Uses {dated.length} videos with exact upload times that are at least 3 days old. It sharpens as the database grows.</p>
      </section>
      <section className="card">
        <div className="card-head"><div><h2>Price segments</h2><span className="muted">From “under ₹…” in titles</span></div></div>
        {prices.length ? <div className="bars">{order.filter(o => prices.some(([k]) => k === o)).map(o => { const list = prices.find(([k]) => k === o)[1], s = median(list); return <div className="hbar" key={o}>
          <span>{o}</span><div className="hbar-track"><div style={{width:Math.min(100, s/3*100)+'%', background:scoreColor(Math.max(s, 1.01))}}/></div><strong>{s.toFixed(1)}×</strong><span className="muted small">{list.length}</span>
        </div>; })}</div> : <div className="spark-empty">No price mentions found in titles.</div>}
        <div className="mixrow">{fmtMix.map(m => <div key={m.f}><span className="kpi-label">{m.f}</span><strong>{short(m.views)}</strong><span className="muted small">median views · {m.n} videos</span></div>)}</div>
      </section>
    </div>
    <section className="card">
      <div className="card-head"><div><h2>Title keywords</h2><span className="muted">Words that appear in 3+ titles, ranked by median performance</span></div></div>
      <div className="kw-grid">
        <div><span className="kpi-label">Lifting performance</span>{top.map(k => <KeywordRow key={k.word} k={k}/>)}{!top.length && <p className="muted">Not enough data yet.</p>}</div>
        <div><span className="kpi-label">Underperforming</span>{weak.map(k => <KeywordRow key={k.word} k={k}/>)}</div>
      </div>
    </section>
  </>;
}
function KeywordRow({k}) {
  return <div className="kw-row" title={'Best: '+k.example.title}><span className="kw">{k.word}</span><div className="hbar-track"><div style={{width:Math.min(100, k.score/3*100)+'%', background:scoreColor(k.score)}}/></div><strong>{k.score.toFixed(1)}×</strong><span className="muted small">{k.count}</span></div>;
}

// ---------- competitor tools ----------
function UploadFeed({competitors}) {
  const feed = competitors.flatMap(c => c.pool.filter(v => !v.approx).map(v => ({...v, ch:c}))).sort((a,b) => new Date(b.published) - new Date(a.published)).slice(0, 12);
  return <section className="card">
    <div className="card-head"><div><h2>Competitor uploads</h2><span className="muted">Newest first, scored against each competitor’s own typical views</span></div></div>
    {feed.length ? <div className="list">{feed.map(v => <a className="list-row" key={v.id} href={'https://www.youtube.com/'+(v.short ? 'shorts/' : 'watch?v=')+v.id} target="_blank" rel="noreferrer">
      <img decoding="async" {...thumbProps(v.thumbnail)} alt="" loading="lazy" referrerPolicy="no-referrer"/>
      <div className="list-main"><span className="video-title">{v.title}</span><span className="video-meta"><span className="dot" style={{background:v.ch.color}}/>{v.ch.name} · {ago(v.published)}{v.short ? ' · Short' : ''}</span></div>
      <div className="list-num"><strong>{short(v.views)}</strong><ScoreChip v={v}/></div>
    </a>)}</div> : <div className="spark-empty">No competitor uploads yet.</div>}
  </section>;
}

function TopicGaps({own, competitors, onPlan}) {
  const mine = new Set(own.flatMap(c => c.pool.flatMap(v => words(v.title))));
  const strong = competitors.flatMap(c => c.pool.filter(v => v.score >= 1.5).map(v => ({...v, ch:c})));
  const map = new Map();
  for (const v of strong) for (const w of words(v.title)) if (!mine.has(w) && !/^\d+$/.test(w)) (map.get(w) ?? map.set(w, []).get(w)).push(v);
  const gaps = [...map.entries()].filter(([, l]) => l.length >= 2).map(([word, l]) => ({word, list:l, score:median(l.map(v => v.score))}))
    .sort((a,b) => b.score*b.list.length - a.score*a.list.length).slice(0, 10);
  const [added, setAdded] = useState({});
  return <section className="card">
    <div className="card-head"><div><h2>Topic gaps</h2><span className="muted">Words in competitors’ strong videos (≥1.5× their typical views) that never appear in your titles</span></div></div>
    {gaps.length ? <div className="table-wrap"><table>
      <thead><tr><th>Topic</th><th>Strong videos</th><th>Median score</th><th>Example</th><th/></tr></thead>
      <tbody>{gaps.map(g => { const ex = [...g.list].sort((a,b) => b.score - a.score)[0]; return <tr key={g.word}>
        <td><strong>{g.word}</strong></td><td>{g.list.length}</td><td className="out-text">{g.score.toFixed(1)}×</td>
        <td className="title-cell"><a href={'https://www.youtube.com/watch?v='+ex.id} target="_blank" rel="noreferrer">{ex.title}</a><span className="muted small"> · {ex.ch.name}</span></td>
        <td><button className="btn ghost" disabled={added[g.word]} onClick={() => onPlan({title:'Idea: '+g.word+' (seen on '+ex.ch.name+')', status:'Idea', notes:'Example: https://youtu.be/'+ex.id}).then(() => setAdded(a => ({...a, [g.word]:true})))}>{added[g.word] ? 'Added' : '+ Plan'}</button></td>
      </tr>; })}</tbody>
    </table></div> : <div className="spark-empty">{competitors.length ? 'No clear gaps yet. More competitor data sharpens this.' : 'Add competitors to find topic gaps.'}</div>}
  </section>;
}

function DualLine({a, b}) {
  const series = [a, b].map(c => { const h = c.history.filter(x => x.s); const base = h[0]?.s; return {c, pts:h.map(x => ({x:x.date, y:base ? (x.s/base - 1)*100 : 0}))}; });
  const all = series.flatMap(s => s.pts);
  if (series.some(s => s.pts.length < 2)) return <div className="spark-empty">Growth comparison appears once both channels have two or more days of history.</div>;
  const dates = [...new Set(all.map(p => p.x))].sort(), ys = all.map(p => p.y), min = Math.min(0, ...ys), max = Math.max(0.01, ...ys);
  const w = 560, h = 140, X = d => 6 + dates.indexOf(d)/(dates.length-1||1)*(w-12), Y = y => h - 6 - (y-min)/(max-min||1)*(h-12);
  return <figure className="spark"><figcaption><span>Subscriber growth, % since first snapshot</span><span>{dates[0]} → {dates.at(-1)}</span></figcaption>
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Growth comparison">{series.map(s => <path key={s.c.id} d={s.pts.map((p,i) => (i?'L':'M')+X(p.x)+' '+Y(p.y)).join(' ')} fill="none" stroke={s.c.color} strokeWidth="2.5" vectorEffect="non-scaling-stroke"/>)}</svg>
    <div className="mix-legend">{series.map(s => <span key={s.c.id}><i style={{background:s.c.color}}/>{s.c.name} {s.pts.at(-1).y.toFixed(2)}%</span>)}</div>
  </figure>;
}

function HeadToHead({channels}) {
  const [ids, setIds] = useState(() => [String(channels.find(c => c.kind === 'own')?.id), String(channels.find(c => c.kind === 'competitor')?.id ?? channels[1]?.id)]);
  const [a, b] = ids.map(id => channels.find(c => String(c.id) === id) ?? channels[0]);
  const sa = stats(a), sb = stats(b);
  const rows = [
    ['Subscribers', a.subscribers, b.subscribers, short],
    ['Subscribers gained, 7d', a.deltas.week?.s, b.deltas.week?.s, short],
    ['Total views', a.totalViews, b.totalViews, short],
    ['Views gained, 7d', a.deltas.week?.v, b.deltas.week?.v, short],
    ['Avg views / video', sa.avgLifetime, sb.avgLifetime, short],
    ['Avg views, recent', sa.avgRecent, sb.avgRecent, short],
    ['Uploads / week', sa.uploadsPerWeek, sb.uploadsPerWeek, n => n == null ? '—' : n.toFixed(1)],
    ['Like rate', sa.likeRate, sb.likeRate, n => n == null ? '—' : n.toFixed(1)+'%'],
    ['Outliers in last 80', a.pool.filter(v => v.outlier).length, b.pool.filter(v => v.outlier).length, fmt]
  ];
  return <section className="card">
    <div className="card-head"><div><h2>Head-to-head</h2><span className="muted">Pick any two channels</span></div>
      <div className="row">{[0,1].map(i => <ChannelSelect key={i} channels={channels} all={false} value={ids[i]} onChange={v => setIds(x => i ? [x[0], v] : [v, x[1]])}/>)}</div></div>
    <div className="h2h">
      <table><thead><tr><th/><th><span className="dot" style={{background:a.color}}/>{a.name}</th><th><span className="dot" style={{background:b.color}}/>{b.name}</th></tr></thead>
        <tbody>{rows.map(([label, x, y, f]) => <tr key={label}><td className="muted">{label}</td>
          <td className={x != null && y != null && x > y ? 'win' : ''}>{f(x)}</td><td className={x != null && y != null && y > x ? 'win' : ''}>{f(y)}</td></tr>)}</tbody></table>
      <DualLine a={a} b={b}/>
    </div>
  </section>;
}

// ---------- weekly report ----------
function Report({own, competitors, alerts}) {
  const since = Date.now() - 7*DAY;
  const inWeek = v => !v.approx && new Date(v.published) >= since;
  const row = c => { const ups = c.pool.filter(inWeek); return {c, ups, best:[...ups].sort((x,y) => (y.score ?? 0) - (x.score ?? 0))[0], outliers:ups.filter(v => v.outlier).length, avg:median(ups.map(v => v.score).filter(x => x != null))}; };
  const mine = own.map(row), theirs = competitors.map(row);
  const range = new Date(since).toLocaleDateString('en-IN', {day:'numeric', month:'short'})+' – '+new Date().toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'});
  const total = f => own.some(c => c.deltas.week) ? own.reduce((s,c) => s + (c.deltas.week?.[f] ?? 0), 0) : null;
  return <div className="report">
    <div className="toolbar"><span className="muted">Weekly report · {range}</span><button className="btn" onClick={() => window.print()}>Print / Save as PDF</button></div>
    <section className="kpis">
      <Kpi label="Subscribers gained" value={total('s') == null ? '—' : short(total('s'))} sub="all your channels"/>
      <Kpi label="Views gained" value={total('v') == null ? '—' : short(total('v'))} sub="all your channels"/>
      <Kpi label="Uploads" value={fmt(mine.reduce((s,r) => s + r.ups.length, 0))} sub="this week"/>
      <Kpi label="Outliers" value={fmt(mine.reduce((s,r) => s + r.outliers, 0))} sub="uploads ≥ 2× typical"/>
    </section>
    <section className="card">
      <div className="card-head"><h2>Your channels</h2></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Channel</th><th>Subs gained</th><th>Views gained</th><th>Uploads</th><th>Median score</th><th>Best upload</th></tr></thead>
        <tbody>{mine.map(r => <tr key={r.c.id}><td><span className="dot" style={{background:r.c.color}}/>{r.c.name}</td>
          <td>{r.c.deltas.week ? short(r.c.deltas.week.s) : '—'}</td><td>{r.c.deltas.week ? short(r.c.deltas.week.v) : '—'}</td><td>{r.ups.length}</td>
          <td>{r.avg == null ? '—' : r.avg.toFixed(1)+'×'}</td><td className="title-cell">{r.best ? <>{r.best.title} <ScoreChip v={r.best}/></> : '—'}</td></tr>)}</tbody>
      </table></div>
    </section>
    {theirs.length > 0 && <section className="card">
      <div className="card-head"><h2>Competitors</h2></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Channel</th><th>Competes with</th><th>Subs gained</th><th>Uploads</th><th>Outliers</th><th>Best upload</th></tr></thead>
        <tbody>{theirs.map(r => <tr key={r.c.id}><td><span className="dot" style={{background:r.c.color}}/>{r.c.name}</td><td className="muted">{r.c.rivalNames}</td>
          <td>{r.c.deltas.week ? short(r.c.deltas.week.s) : '—'}</td><td>{r.ups.length}</td><td>{r.outliers}</td>
          <td className="title-cell">{r.best ? <>{r.best.title} <ScoreChip v={r.best}/></> : '—'}</td></tr>)}</tbody>
      </table></div>
    </section>}
    <section className="card">
      <div className="card-head"><h2>Highlights</h2></div>
      <AlertList alerts={alerts.filter(a => new Date(a.ts) >= since)} channels={[...own, ...competitors]}/>
    </section>
  </div>;
}

// ---------- alerts ----------
const ALERT_ICON = {outlier:'▲', upload:'●', milestone:'★', published:'✓', ranking:'#'};
function AlertList({alerts, channels}) {
  if (!alerts.length) return <div className="spark-empty">No alerts yet. You’ll see outliers, milestones, competitor uploads and published plans here.</div>;
  return <div className="list">{alerts.map(a => { const c = channels.find(x => x.id === a.channel); return <div className={'alert-row'+(a.read ? '' : ' unread')} key={a.id}>
    <span className={'alert-icon k-'+a.kind} style={{'--c':c?.color}}>{ALERT_ICON[a.kind] ?? '•'}</span>
    <div className="list-main"><strong>{a.title}</strong>{a.body && <span className="video-meta">{a.video ? <a href={'https://youtu.be/'+a.video} target="_blank" rel="noreferrer">{a.body}</a> : a.body}</span>}</div>
    <span className="muted small">{ago(a.ts)}</span>
  </div>; })}</div>;
}

function Alerts({data, onRead, onSettings}) {
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  return <>
    <section className="card">
      <div className="card-head"><div><h2>Notifications</h2><span className="muted">Checked on every hourly update</span></div>
        <div className="row">
          {perm === 'default' && <button className="btn" onClick={() => Notification.requestPermission().then(setPerm)}>Enable desktop notifications</button>}
          {perm === 'granted' && <span className="chip chip-up">Desktop notifications on</span>}
          {perm === 'denied' && <span className="chip">Desktop notifications blocked in browser settings</span>}
          <span className="chip">{['discord','slack'].filter(k => data.notifications[k].enabled).map(k => SERVICE_INFO[k].name).join(' + ') || 'No webhooks'} · <a className="inline-link" href="#settings" onClick={e => { e.preventDefault(); onSettings(); }}>Settings</a></span>
          {data.unread > 0 && <button className="btn" onClick={onRead}>Mark all read</button>}
        </div>
      </div>
      <AlertList alerts={data.alerts} channels={data.channels}/>
    </section>
  </>;
}

// ---------- small persisted preferences ----------
const pref = (k, d) => { try { const v = localStorage.getItem('ytd.'+k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem('ytd.'+k, JSON.stringify(v)); } catch {} };
function usePref(k, d) {
  const [v, set] = useState(() => pref(k, d));
  return [v, x => { set(x); setPref(k, x); }];
}
const applyDensity = on => document.documentElement.classList.toggle('compact', !!on);
applyDensity(pref('compact', false));
const applyTheme = t => t ? document.documentElement.setAttribute('data-theme', t) : document.documentElement.removeAttribute('data-theme');
applyTheme(pref('theme', null));
const currentTheme = () => document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
function ThemeButton() {
  const [t, setT] = useState(currentTheme);
  const flip = () => { const n = t === 'dark' ? 'light' : 'dark'; applyTheme(n); setPref('theme', n); setT(n); };
  return <button className="btn icon" onClick={flip} aria-label={'Switch to '+(t === 'dark' ? 'light' : 'dark')+' mode'} title={'Switch to '+(t === 'dark' ? 'light' : 'dark')+' mode'}>{t === 'dark' ? '☀' : '☾'}</button>;
}

// ---------- date range ----------
const RANGES = [[7,'7D'],[30,'30D'],[90,'90D'],[0,'All']];
function RangeSeg({value, onChange}) {
  return <div className="seg sm" role="group" aria-label="Date range">{RANGES.map(([d, l]) => <button key={d} aria-pressed={value === d} onClick={() => onChange(d)}>{l}</button>)}</div>;
}
const inRange = (history, days) => days ? history.filter(h => new Date(h.date) >= Date.now() - days * DAY) : history;

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

// ---------- nodes ----------
const upFor = sec => { if (sec == null) return '—'; const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60); return d ? d+'d '+h+'h' : h ? h+'h '+m+'m' : m+'m'; };
const gb = n => n == null ? '—' : n >= 1e12 ? (n / 1e12).toFixed(1)+' TB' : (n / 1e9).toFixed(n >= 1e11 ? 0 : 1)+' GB';
const JOB_LABEL = {updates: 'Hourly channel update'};
const jobName = n => JOB_LABEL[n] ?? (n.startsWith('rank:') ? 'Ranking budget #'+n.slice(5) : n);
const HEALTH = {healthy: 'Healthy', stale: 'Late heartbeat', offline: 'Offline'};
// Times a node from this browser (the ping endpoint allows any origin).
async function pingNode(url) {
  if (!url) return null;
  const t0 = performance.now();
  try { const r = await fetch(url + '/api/node/ping', {cache: 'no-store', signal: AbortSignal.timeout(4000)}); if (!r.ok) return null; await r.json(); return Math.round(performance.now() - t0); }
  catch { return null; }
}
function NodeCard({n, self, serving, busy, onMode, onRemove, latency}) {
  const st = n.stats ?? {}, memUsed = st.mem ? 1 - st.mem.free / st.mem.total : null, diskFree = st.disk?.free;
  const work = st.work ?? {}, workTotal = Object.values(work).reduce((a, b) => a + b, 0);
  const limited = st.rateLimitedUntil && new Date(st.rateLimitedUntil) > Date.now();
  const offline = n.health === 'offline';
  return <article className={'node '+n.health+(n.mode !== 'active' ? ' mode-'+n.mode : '')}>
    <header className="node-head">
      <span className="node-dot" aria-hidden="true"/>
      <div className="node-title">
        <strong>{n.name}</strong>{REMOTE ? serving && <span className="pill">Serving this page</span> : self && <span className="pill">This node</span>}
        {st.tunnel && <span className={'pill '+(st.tunnel.state === 'up' ? '' : 'warn')} title={st.tunnel.error ?? 'Reachable from the internet through a Cloudflare tunnel'}>{st.tunnel.state === 'up' ? 'Internet ✓' : 'Tunnel '+st.tunnel.state}</span>}
        {n.mode !== 'active' && <span className={'pill '+n.mode}>{n.mode === 'draining' ? 'Draining' : 'Disabled'}</span>}
        {n.outdated && <span className="pill warn" title="Its server code differs from the newest node. Update it so all nodes behave the same.">Different version</span>}
        <div className="muted small">{HEALTH[n.health]} · heartbeat {agoS(n.last_seen)}{n.lan_url && n.lan_url !== n.url && <> · <a href={n.lan_url} target="_blank" rel="noreferrer">{n.lan_url.replace(/^https?:\/\//, '')}</a></>}{n.url && <> · <a href={n.url} target="_blank" rel="noreferrer">{n.url.replace(/^https?:\/\//, '')}</a></>}</div>
      </div>
      <div className="node-ping" title="Response time from this browser">{offline ? '—' : latency === undefined ? <span className="spinner"/> : latency == null ? <span className="down small">unreachable</span> : <><b>{latency}</b><span className="muted small"> ms</span></>}</div>
    </header>
    <div className="node-now">{offline ? <span className="muted">Last seen {ago(n.last_seen)}</span>
      : limited ? <span className="warn-text">YouTube is limiting this node · resumes {new Date(st.rateLimitedUntil).toLocaleTimeString('en-IN', {hour:'2-digit', minute:'2-digit'})}</span>
      : st.current ? <><span className="spinner sm"/> {st.current}</> : <span className="muted">{n.mode === 'active' ? 'Idle, waiting for the next job' : n.mode === 'draining' ? 'Finished its work; taking no new jobs' : 'Not taking any jobs'}</span>}</div>
    <dl className="node-stats">
      <div><dt>CPU</dt><dd>{st.cpu == null ? '—' : st.cpu+'%'}<span className="muted small"> · {st.cpus ?? '—'} cores</span></dd></div>
      <div><dt>Memory</dt><dd>{memUsed == null ? '—' : Math.round(memUsed * 100)+'%'}<span className="muted small"> · app {mb(st.rss)}</span></dd></div>
      <div><dt>Disk free</dt><dd>{gb(diskFree)}</dd></div>
      <div><dt>Up for</dt><dd>{upFor(st.uptime)}</dd></div>
      <div><dt>Work last hour</dt><dd>{workTotal ? fmt(workTotal) : '0'}<span className="muted small">{workTotal ? ' · '+Object.entries(work).map(([k, v]) => v+' '+k).join(', ') : ''}</span></dd></div>
      <div><dt>Database writes</dt><dd>{st.db?.syncError ? <span className="down">sync failing</span> : st.db?.writeMs != null ? st.db.writeMs+' ms' : '—'}</dd></div>
    </dl>
    {n.leases.length > 0 && <div className="node-leases muted small">Holding: {n.leases.map(l => jobName(l.name)).join(', ')}</div>}
    <footer className="node-foot">
      <span className="muted small">{n.version} · {st.node ?? ''} · {n.platform ?? ''}</span>
      <div className="row">
        {n.mode === 'active' && !offline && <button className="btn sm" disabled={!!busy} onClick={() => onMode(n, 'draining')}>Drain</button>}
        {n.mode !== 'active' && <button className="btn sm" disabled={!!busy} onClick={() => onMode(n, 'active')}>Resume</button>}
        {n.mode !== 'disabled' && !offline && <button className="btn sm" disabled={!!busy} onClick={() => onMode(n, 'disabled')}>Disable</button>}
        {offline && !self && <button className="btn sm danger" disabled={!!busy} onClick={() => onRemove(n)}>Remove</button>}
      </div>
    </footer>
  </article>;
}
function AddNode({cloud}) {
  const [name, setName] = useState('');
  const env = `NODE_NAME=${name.trim() || 'Laptop'}\nDATABASE_URL=<same as this PC's .env>\nDATABASE_TOKEN=<same as this PC's .env>\nAUTH_SECRET=<same as this PC's .env>\nTUNNEL=quick\nPORT=4173`;
  const copy = text => navigator.clipboard?.writeText(text).then(() => toast('Copied.', {kind:'ok'}), () => toast('Copy failed. Select the text instead.', {kind:'error'}));
  return <section className="card">
    <div className="card-head"><div><h2>Add a node</h2><span className="muted">Any PC, laptop or small server with Node.js 22.13+ can share the work</span></div></div>
    {!cloud ? <p className="muted">This server uses the local database file. Nodes need the shared cloud database first (DATABASE_URL in .env).</p> : <ol className="add-node">
      <li>Copy the <code>youtube-dashboard</code> folder to the device (without <code>data</code> and <code>node_modules</code>), then run <code>npm install</code> in it.</li>
      <li><span>Create a <code>.env</code> file in that folder:</span>
        <label className="inline" style={{margin:'8px 0'}}>Node name <input value={name} onChange={e => setName(e.target.value)} placeholder="Laptop" maxLength={60}/></label>
        <div className="code-block"><pre>{env}</pre><button className="btn sm" onClick={() => copy(env)}>Copy</button></div>
        <span className="muted small">Copy the DATABASE and AUTH_SECRET lines from this PC's <code>.env</code>. They are never shown in the browser. <code>TUNNEL=quick</code> makes it reachable from the Vercel page (needs cloudflared installed).</span></li>
      <li>Start it: <code>npm run node</code>. It appears here within 15 seconds and starts taking work.</li>
    </ol>}
  </section>;
}
function NodesPage() {
  const [d, setD] = useState(null), [err, setErr] = useState(''), [busy, setBusy] = useState(null), [lat, setLat] = useState({});
  const load = () => api('/api/nodes').then(x => { setD(x); setErr(''); return x; }).catch(e => setErr(e.message));
  // From the Vercel page only the internet address works; on the home network the direct address is faster.
  const measure = x => x?.nodes.filter(n => n.health !== 'offline').forEach(n => pingNode(REMOTE ? n.url : n.lan_url || n.url).then(ms => setLat(l => ({...l, [n.id]: ms}))));
  useEffect(() => {
    load().then(measure);
    const t = setInterval(load, 5000), p = setInterval(() => load().then(measure), 30000);
    return () => { clearInterval(t); clearInterval(p); };
  }, []);
  if (err && !d) return <div className="card"><p className="error" role="alert">{err}</p><button className="btn" onClick={load}>Retry</button></div>;
  if (!d) return <PageSkeleton/>;
  const run = async (k, fn) => { setBusy(k); try { setD(await fn()); } catch (e) { toast(e.message, {kind:'error'}); } finally { setBusy(null); } };
  const onMode = async (n, mode) => {
    if (mode === 'disabled' && !(await ask(`Disable "${n.name}"? It stops its current job and gives it to another node.`, 'Disable'))) return;
    run(n.id, () => api('/api/nodes/'+n.id+'/mode', {method:'POST', body:JSON.stringify({mode})}));
  };
  const onRemove = async n => { if (await ask(`Remove "${n.name}" from the list? If it starts again it signs itself back in.`, 'Remove')) run(n.id, () => api('/api/nodes/'+n.id, {method:'DELETE'})); };
  const online = d.nodes.filter(n => n.health !== 'offline'), working = online.filter(n => n.mode === 'active');
  const work = d.nodes.reduce((t, n) => t + Object.values(n.stats?.work ?? {}).reduce((a, b) => a + b, 0), 0);
  const versions = new Set(online.map(n => n.version));
  const fastest = Object.entries(lat).filter(([id, ms]) => ms != null && online.some(n => n.id === id && n.mode === 'active')).sort((a, b) => a[1] - b[1])[0];
  return <>
    <section className="kpis six">
      <Kpi label="Nodes online" value={online.length+' / '+d.nodes.length} sub={working.length+' taking work'}/>
      <Kpi label="Work last hour" value={fmt(work)} sub="channel updates + searches"/>
      <Kpi label="Jobs in progress" value={d.leases.length} sub={d.leases.length ? [...new Set(d.leases.map(l => l.node))].join(', ') : 'none right now'}/>
      <Kpi label="Fastest from here" value={fastest ? d.nodes.find(n => n.id === fastest[0])?.name : '—'} sub={fastest ? fastest[1]+' ms' : 'measuring…'}/>
      <Kpi label="Versions" value={versions.size <= 1 ? 'Matching' : versions.size+' different'} sub={versions.size <= 1 ? [...versions][0] ?? '—' : 'update the older nodes'}/>
      <Kpi label="Heartbeat" value={'every '+d.heartbeat+'s'} sub={'late after '+d.staleAfter+'s · offline after '+d.offlineAfter+'s'}/>
    </section>
    <section className="card">
      <div className="card-head"><div><h2>Nodes</h2><span className="muted">Every server using the shared database. Ranking budgets are shared out between active nodes; the hourly update runs on one of them.</span></div>
        <button className="btn" onClick={() => load().then(measure)}>Refresh</button></div>
      <div className="nodes">{d.nodes.map(n => <NodeCard key={n.id} n={n} self={n.id === d.self} serving={REMOTE && remoteState().node?.id === n.id} busy={busy} onMode={onMode} onRemove={onRemove} latency={lat[n.id]}/>)}</div>
      {d.nodes.length === 0 && <div className="spark-empty">No nodes yet. This server signs in within 15 seconds of starting.</div>}
    </section>
    <div className="split">
      <AddNode cloud={d.cloud}/>
      <section className="card">
        <div className="card-head"><div><h2>Jobs in progress</h2><span className="muted">Held by one node at a time; if it stops, the job goes to another node</span></div></div>
        {d.leases.length ? <ul className="db-gaps">{d.leases.map(l => <li key={l.name}><span>{jobName(l.name)}</span><span className="muted small">{l.node} · until {new Date(l.until).toLocaleTimeString('en-IN', {hour:'2-digit', minute:'2-digit'})}</span></li>)}</ul>
          : <div className="spark-empty">Nothing running right now.</div>}
      </section>
    </div>
  </>;
}

// ---------- database health ----------
const mb = n => n == null ? '—' : n >= 1e9 ? +(n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB';
const SETTINGS_UI = [
  ['Backups', [
    ['backupEveryHours', 'Back up every', 'hours', 'How often a checked copy of the database is saved.', [6, 168]],
    ['backupKeepDays', 'Keep daily backups for', 'days', 'Older backups are deleted (the 3 newest are always kept).', [3, 90]]]],
  ['Data retention', [
    ['rankResultsDays', 'Keep ranking checks for', 'days', 'Older search-ranking checks are deleted. 0 keeps them forever.', [0, 3650]],
    ['thinSnapshotsDays', 'Thin video view history after', 'days', 'Older view snapshots are reduced to one per day per video. 0 never thins.', [0, 3650]],
    ['alertsDays', 'Delete read alerts after', 'days', 'Unread alerts are always kept. 0 keeps them forever.', [0, 3650]],
    ['incidentsDays', 'Delete resolved ranking incidents after', 'days', 'Open incidents are always kept. 0 keeps them forever.', [0, 3650]]]],
  ['Maintenance', [
    ['autoMaintenance', 'Automatic maintenance', null, 'Daily cleanup and log checkpoint, weekly optimize and quick check, compact when 20%+ of the file is unused.'],
    ['integrityOnStart', 'Check the database when the server starts', null, 'A quick integrity check; a damaged file is set aside and the newest backup restored.']]]
];
const ACTIONS = [
  ['quick-check', 'Quick check', 'Fast integrity check (a few seconds).'],
  ['integrity-check', 'Full integrity check', 'Checks every page and index. Slower.'],
  ['cleanup', 'Clean up now', 'Apply the retention settings above right away.'],
  ['checkpoint', 'Checkpoint log', 'Merge the write-ahead log into the main file.'],
  ['optimize', 'Optimize', 'Refresh query statistics so pages load faster.'],
  ['vacuum', 'Compact', 'Rebuild the file to reclaim unused space. Pauses writes briefly.']
];
const agoS = d => { if (!d) return '—'; const s = (Date.now() - new Date(d)) / 1000; return s < 60 ? Math.max(1, Math.round(s)) + 's ago' : ago(d); };
const pct = (n, of) => n == null || !of ? null : Math.min(100, n / of * 100);
function UsageBar({label, value, limit, fmtv}) {
  const p = pct(value, limit);
  return <div className="cl-usage">
    <div className="cl-usage-top"><span>{label}</span><span className="muted small">{value == null ? '—' : fmtv(value)} of {fmtv(limit)}{p != null && <b className={p >= 90 ? 'down' : p >= 70 ? 'warn' : ''}> · {p < 1 && p > 0 ? '<1' : Math.round(p)}%</b>}</span></div>
    <div className="cl-bar" role="progressbar" aria-label={label} aria-valuenow={p == null ? undefined : Math.round(p)} aria-valuemin={0} aria-valuemax={100}><span style={{width: (p ? Math.max(p, 1) : 0) + '%'}} className={p >= 90 ? 'bad' : p >= 70 ? 'warn' : ''}/></div>
  </div>;
}
function CloudCard({m, busy, act}) {
  const w = m.writes ?? {}, u = m.usage, avgDirect = w.direct ? Math.round(w.directMs / w.direct) : null;
  const rows = [
    ['Database', <code>{m.host}</code>],
    ['Region', m.regionName ? m.regionName + (m.region && m.regionName !== m.region ? ' (' + m.region + ')' : '') : '—'],
    ['Local copy', mb(m.replica) + ' · reads are served from it'],
    ['Sync', m.syncError ? <span className="down">failing: {m.syncError}</span> : <>every {m.every}s · last {agoS(m.syncedAt)} · {m.syncMs} ms</>],
    ['Batched writes', w.batches ? `${fmt(w.batches)} batches, ${fmt(w.rows)} rows · last took ${w.lastMs} ms` : 'none yet'],
    ['Single writes', w.direct ? `${fmt(w.direct)} · about ${avgDirect} ms each` : 'none yet'],
    ['Failed writes', w.failed ? <span className="down">{fmt(w.failed)} rows{w.error ? ' · ' + w.error : ''}</span> : 'none'],
  ];
  return <section className="card">
    <div className="card-head"><div><h2>Cloud database</h2><span className="muted">Turso · shared by every node · counters since this server started {ago(m.since)}</span></div>
      <div className="row">
        <button className="btn" disabled={!!busy} onClick={() => act('sync', 'Sync')}>{busy === 'sync' ? <span className="spinner"/> : 'Sync now'}</button>
        <button className="btn primary" disabled={!!busy} onClick={() => act('ping', 'Connection')}>{busy === 'ping' ? <span className="spinner"/> : 'Test connection'}</button>
      </div></div>
    <div className="cl-grid">
      <dl className="cl-facts">{rows.map(([k, v]) => <div key={k}><dt className="muted small">{k}</dt><dd>{v}</dd></div>)}</dl>
      <div className="cl-plan">
        <div className="row" style={{justifyContent:'space-between'}}><strong>This month{u?.plan ? ' · ' + u.plan + ' plan' : ''}</strong>
          {u && <button className="btn sm" disabled={!!busy} onClick={() => act('usage', 'Usage')}>{busy === 'usage' ? <span className="spinner"/> : 'Refresh'}</button>}</div>
        {u && !u.error && u.rowsRead != null ? <>
          <UsageBar label="Rows read" value={u.rowsRead} limit={m.free.rowsRead} fmtv={short}/>
          <UsageBar label="Rows written" value={u.rowsWritten} limit={m.free.rowsWritten} fmtv={short}/>
          <UsageBar label="Storage" value={u.storage} limit={m.free.storage} fmtv={mb}/>
          <p className="muted small">{u.synced != null && <>Data synced to nodes: {mb(u.synced)}. </>}{u.resets && <>Resets {new Date(u.resets).toLocaleDateString('en-IN', {day:'numeric', month:'short'})}. </>}Limits shown are the free plan's. Checked {ago(u.checkedAt)}. If a limit is reached, Turso refuses queries until next month; the free plan never bills you.</p>
        </> : u?.error ? <p className="error small">{u.error}</p>
          : u ? <div className="skeleton" style={{height:90}}/>
          : <p className="muted small">To see usage against the free plan here (rows read, rows written, storage), create an API token in Turso
            (Settings → API Tokens) and add it to <code>.env</code> as <code>TURSO_API_TOKEN=…</code>, then restart the server.</p>}
      </div>
    </div>
  </section>;
}
function DatabasePage() {
  const [h, setH] = useState(null), [err, setErr] = useState(''), [busy, setBusy] = useState(null), [form, setForm] = useState(null);
  const load = () => api('/api/db/health').then(x => { setH(x); setForm(f => f ?? x.settings); setErr(''); }).catch(e => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 30e3); return () => clearInterval(t); }, []);
  if (err && !h) return <div className="card"><p className="error" role="alert">{err}</p><button className="btn" onClick={load}>Retry</button></div>;
  if (!h) return <PageSkeleton/>;
  const act = async (a, label) => {
    if (a === 'cleanup' && !(await ask('Remove data older than the retention settings now? A backup is made first.', 'Clean up'))) return;
    setBusy(a);
    try {
      if (a === 'cleanup' || a === 'vacuum') await api('/api/backups', {method:'POST'});
      const r = await api('/api/db/action', {method:'POST', body:JSON.stringify({action:a})});
      setH(r.health); toast(label+': '+r.message, {kind: r.ok ? 'ok' : 'error', ttl: 6000});
    } catch (e) { toast(e.message, {kind:'error'}); } finally { setBusy(null); }
  };
  const dirty = form && Object.keys(form).some(k => form[k] !== h.settings[k]);
  const save = async () => { setBusy('save'); try { const x = await api('/api/db/settings', {method:'POST', body:JSON.stringify(form)}); setH(x); setForm(x.settings); toast('Database settings saved.', {kind:'ok'}); } catch (e) { toast(e.message, {kind:'error'}); } finally { setBusy(null); } };
  const f = h.file, integ = h.integrity, m = h.maintenance ?? {}, cloudMode = h.mode?.kind === 'cloud';
  const label = {good: 'Healthy', warn: 'Needs attention', bad: 'Problem found'}[h.status];
  return <>
    <section className={'db-status '+h.status}>
      <span className="db-dot" aria-hidden="true"/>
      <div><strong>{label}</strong>
        {h.issues.length ? <ul>{h.issues.map((i, n) => <li key={n} className={i.level}>{i.text}</li>)}</ul> : <p className="muted small">Integrity, backups and file size all look good.</p>}</div>
      <button className="btn" onClick={load}>Refresh</button>
    </section>

    <section className="kpis six">
      {cloudMode ? <>
        <Kpi label="Last sync" value={h.mode.syncError ? 'Failing' : agoS(h.mode.syncedAt)} sub={h.mode.syncError ? 'check the connection' : h.mode.syncMs+' ms · every '+h.mode.every+'s'}/>
        <Kpi label="Write speed" value={h.mode.writes?.direct ? Math.round(h.mode.writes.directMs / h.mode.writes.direct)+' ms' : '—'} sub={h.mode.writes?.batches ? 'batch of '+Math.round(h.mode.writes.rows / h.mode.writes.batches)+' rows: '+h.mode.writes.lastMs+' ms' : 'per single write'}/>
      </> : <>
        <Kpi label="Database size" value={mb(f.size)} sub={'+ '+mb(f.wal)+' log · '+f.pages.toLocaleString('en-IN')+' pages'}/>
        <Kpi label="Unused space" value={f.freePct+'%'} sub={f.freePct > 20 ? 'compact recommended' : 'fine'}/>
      </>}
      <Kpi label={cloudMode ? 'Local copy integrity' : 'Integrity'} value={integ ? (integ.result === 'ok' ? 'OK' : 'Problems') : '—'} sub={integ ? (integ.kind === 'full' ? 'full' : 'quick')+' check '+ago(integ.at) : 'not checked yet'}/>
      <Kpi label="Backups" value={h.backups.count} sub={mb(h.backups.size)+' · last '+(h.backups.last ? ago(h.backups.last) : 'never')}/>
      <Kpi label="Rows stored" value={short(h.tables.reduce((t, x) => t + x.rows, 0))} sub={h.tables.length+' tables'}/>
      {cloudMode
        ? <Kpi label="Storage" value="Turso cloud" sub={(h.mode.regionName ? h.mode.regionName+' · ' : '')+'local copy '+mb(h.mode.replica)}/>
        : <Kpi label="Storage" value="This PC" sub={'SQLite '+f.sqlite+' · '+f.journal.toUpperCase()}/>}
    </section>

    {cloudMode && <CloudCard m={h.mode} busy={busy} act={act}/>}

    <section className="card">
      <div className="card-head"><div><h2>Maintenance</h2><span className="muted">{cloudMode ? "Turso compacts and optimizes the cloud database itself. Checks run on this node's local copy; clean up applies to every node." : 'Safe to run any time. Clean up and Compact make a backup first.'}</span></div></div>
      <div className="db-actions">{ACTIONS.filter(([a]) => !cloudMode || !['optimize', 'checkpoint', 'vacuum'].includes(a)).map(([a, l, d]) => <button key={a} className="db-action" disabled={!!busy} onClick={() => act(a, l)}>
        <span className="db-action-l">{busy === a ? <span className="spinner"/> : l}</span><span className="muted small">{d}</span>
        <span className="muted small db-last">{m[a === 'quick-check' || a === 'integrity-check' ? '' : a]?.at ? 'last '+ago(m[a].at) : a.includes('check') && integ ? 'last '+ago(integ.at) : ''}</span></button>)}</div>
    </section>

    <section className="card">
      <div className="card-head"><div><h2>Settings</h2><span className="muted">Backups, how long data is kept, and automatic maintenance</span></div>
        <div className="row">{dirty && <button className="btn" onClick={() => setForm(h.settings)}>Undo</button>}<button className="btn primary" disabled={!dirty || !!busy} onClick={save}>{busy === 'save' ? <span className="spinner"/> : 'Save settings'}</button></div></div>
      <div className="db-settings">{SETTINGS_UI.map(([group, items]) => <fieldset key={group}><legend>{group}</legend>
        {items.filter(([k]) => !cloudMode || k !== 'integrityOnStart').map(([k, l, unit, help0, range]) => { const help = !cloudMode ? help0 : k === 'autoMaintenance' ? 'Daily cleanup by the retention settings and a weekly quick check of the local copy.' : k === 'backupEveryHours' ? 'How often a checked copy is saved on this PC, taken from the local copy of the cloud database.' : help0; return <label key={k} className={'db-set'+(unit ? '' : ' toggle')}>
          <span className="db-set-l">{l}<span className="muted small">{help}</span></span>
          {unit ? <span className="db-num"><input type="number" min={range[0]} max={range[1]} value={form?.[k] ?? ''} onChange={e => setForm({...form, [k]: e.target.value === '' ? '' : Number(e.target.value)})}/><span className="muted small">{unit}</span></span>
            : <input type="checkbox" className="switch" checked={!!form?.[k]} onChange={e => setForm({...form, [k]: e.target.checked})}/>}
        </label>; })}</fieldset>)}</div>
    </section>

    <BackupCard/>

    <div className="split">
      <section className="card">
        <div className="card-head"><div><h2>What's stored</h2><span className="muted">Rows per table and the time span they cover</span></div></div>
        <div className="table-wrap"><table>
          <thead><tr><th>Data</th><th className="num">Rows</th><th className="num">Last 7 days</th><th>Oldest</th><th>Newest</th></tr></thead>
          <tbody>{h.tables.map(t => <tr key={t.table}><td>{t.label}</td><td className="num">{fmt(t.rows)}</td><td className="num muted">{t.week == null ? '—' : fmt(t.week)}</td>
            <td className="muted small">{t.oldest ? shortDate(t.oldest) : '—'}</td><td className="muted small">{t.newest ? ago(t.newest) : '—'}</td></tr>)}</tbody>
        </table></div>
      </section>
      <section className="card">
        <div className="card-head"><div><h2>Gaps in tracking</h2><span className="muted">Times with no channel update for 3+ hours (last 30 days)</span></div></div>
        {h.gaps.length ? <ul className="db-gaps">{h.gaps.map(g => <li key={g.from}><span>{new Date(g.from).toLocaleString('en-IN', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'})} → {new Date(g.to).toLocaleString('en-IN', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'})}</span><b className={g.hours >= 12 ? 'down' : ''}>{g.hours} h</b></li>)}</ul>
          : <div className="spark-empty">No gaps. The dashboard has been updating continuously.</div>}
        <p className="muted small">Gaps happen when the PC or server is off. Daily and weekly numbers spanning a gap are estimates. Keeping the dashboard on an always-on machine avoids them.</p>
      </section>
    </div>
    <p className="muted small">{cloudMode ? <>Local copy: <code>{f.path}</code> · SQLite {f.sqlite}</> : <>File: <code>{f.path}</code></>}</p>
  </>;
}

// ---------- settings extras ----------
// Backups: daily automatic copies of the database, plus an optional second folder (e.g. Google Drive).
function BackupCard() {
  const [b, setB] = useState(null), [busy, setBusy] = useState(null);
  const load = () => api('/api/backups').then(setB).catch(() => {});
  useEffect(() => { load(); }, []);
  const run = async (k, fn) => { setBusy(k); try { setB(await fn()); } catch (err) { toast(err.message, {kind:'error'}); } finally { setBusy(null); } };
  const size = n => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB';
  return <section className="card">
    <div className="card-head"><div><h2>Backups</h2><span className="muted">A checked copy of all history every day · last 14 days kept · damaged databases are restored automatically</span></div>
      <button className="btn primary" disabled={!!busy} onClick={() => run('now', async () => { const r = await api('/api/backups', {method:'POST'}); toast('Backup saved.', {kind:'ok'}); return r; })}>{busy === 'now' ? <span className="spinner"/> : 'Back up now'}</button></div>
    {!b ? <div className="skeleton" style={{height:60}}/> : <>
      <p className="muted small" style={{marginTop:0}}>{b.last ? 'Last backup '+ago(b.last) : 'No backup yet'} · {b.files.length} saved in <code>{b.dir}</code>{b.error && <span className="error"> · Last attempt failed: {b.error}</span>}</p>
      <form className="row wrap" onSubmit={e => { e.preventDefault(); const mirror = new FormData(e.currentTarget).get('mirror'); run('mirror', async () => { const r = await api('/api/settings/backup', {method:'POST', body:JSON.stringify({mirror})}); toast(mirror ? 'Second backup folder saved.' : 'Second backup folder removed.', {kind:'ok'}); return r; }); }}>
        <label className="inline" style={{flex:1, minWidth:260}}>Also copy to<input name="mirror" defaultValue={b.mirror} placeholder="e.g. G:\My Drive\Channel Studio backups (optional)" style={{flex:1}}/></label>
        <button className="btn" disabled={!!busy}>{busy === 'mirror' ? <span className="spinner"/> : 'Save'}</button>
      </form>
      {b.files.length > 0 && <ul className="backup-list">{b.files.slice(0, 5).map(f => <li key={f.name}><span>{new Date(f.at).toLocaleString('en-IN', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'})}</span><span className="muted small">{size(f.size)}</span></li>)}</ul>}
    </>}
  </section>;
}
function DigestCard({cfg, connected, call}) {
  const [busy, setBusy] = useState(null);
  const run = async (k, fn) => { setBusy(k); try { await fn(); } catch (err) { toast(err.message, {kind:'error'}); } finally { setBusy(null); } };
  const set = body => run('set', () => call('/api/settings/digest', {method:'POST', body:JSON.stringify(body)}));
  return <section className="card">
    <div className="card-head"><div><h2>Digest</h2><span className="muted">One summary of growth, outliers, rankings and competitor uploads</span></div>
      <div className="seg sm" role="group" aria-label="Digest frequency">{[['off','Off'],['daily','Daily'],['weekly','Weekly (Mon)']].map(([k, l]) => <button key={k} aria-pressed={cfg.mode === k} disabled={!!busy} onClick={() => set({mode:k})}>{l}</button>)}</div></div>
    <div className="row wrap">
      <label className="inline">Send after <select value={cfg.hour} disabled={!!busy || cfg.mode === 'off'} onChange={e => set({hour:Number(e.target.value)})}>{Array.from({length:24}, (_, h) => <option key={h} value={h}>{String(h).padStart(2,'0')}:00</option>)}</select></label>
      <span className="muted small">{cfg.last ? 'Last sent '+ago(cfg.last) : 'Not sent yet'}{!connected && ' · connect Discord or Slack above'}</span>
      <button className="btn" style={{marginLeft:'auto'}} disabled={!connected || !!busy} onClick={() => run('send', async () => { await call('/api/settings/digest/send', {method:'POST'}); toast('Digest sent.', {kind:'ok'}); })}>{busy === 'send' ? <span className="spinner"/> : 'Send one now'}</button>
    </div>
  </section>;
}
function DisplayCard() {
  const [compactOn, setCompact] = usePref('compact', false);
  return <section className="card">
    <div className="card-head"><div><h2>Display</h2><span className="muted">Compact mode tightens spacing to fit more on smaller screens</span></div>
      <label className="switch"><input type="checkbox" checked={compactOn} onChange={e => { setCompact(e.target.checked); applyDensity(e.target.checked); }}/><span/>Compact</label></div>
    <p className="muted small" style={{margin:0}}>Shortcut: press <kbd>Ctrl</kbd>+<kbd>K</kbd> (<kbd>⌘</kbd>+<kbd>K</kbd> on Mac) anywhere to search.</p>
  </section>;
}

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

// ---------- images: fade in, fall back on error ----------
if (typeof document !== 'undefined') {
  document.addEventListener('load', e => e.target.tagName === 'IMG' && e.target.classList.add('loaded'), true);
  document.addEventListener('error', e => { if (e.target.tagName === 'IMG') e.target.classList.add('broken'); }, true);
}

// ---------- connection banner ----------
function ConnectionBanner({conn, retryIn, onRetry, stale}) {
  if (conn === 'ok') return null;
  const msg = conn === 'offline' ? 'You’re offline.' : REMOTE ? 'None of your nodes is answering. Is one of the PCs on?' : 'Can’t reach the dashboard server.';
  return <div className={'conn-banner '+conn} role="alert">
    <span className="conn-dot"/><span><b>{msg}</b> {stale ? 'Showing data from '+ago(stale)+'.' : ''} {retryIn > 0 ? 'Retrying in '+retryIn+'s…' : 'Retrying…'}</span>
    <button className="btn" onClick={onRetry} disabled={retryIn === 0}>{retryIn === 0 ? <span className="spinner"/> : 'Retry now'}</button>
  </div>;
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

// ---------- rankings ----------
const rankClass = r => r == null ? 'rk-none' : r <= 2 ? 'rk-top' : r <= 5 ? 'rk-mid' : 'rk-low';
const rankText = q => q.error ? 'Check failed' : !q.ts ? 'Not checked' : q.rank ? '#'+q.rank : 'Not found';

function RankChange({history}) {
  const [prev, now] = history.slice(-2);
  if (history.length < 2 || prev === now) return null;
  const p = prev ?? 21, n = now ?? 21; // "not found" counts as below the last result
  return <span className={'rk-change '+(n < p ? 'up' : 'down')} title={`Was ${prev ? '#'+prev : 'not found'} on the previous check`}>{n < p ? '▲' : '▼'}{prev && now ? Math.abs(p - n) : ''}</span>;
}

function SubEditor({sub, category, onSave, onCancel}) {
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    try { await onSave({id:sub?.id, category, name:d.get('name'), queries:d.get('queries')}); }
    catch (err) { setError(err.message); }
  }
  return <form className="editor" onSubmit={submit}>
    <div className="fields">
      <label className="wide">Name<input name="name" defaultValue={sub?.name ?? ''} placeholder="e.g. Under ₹60K" required maxLength="80"/></label>
      <label className="wide">Search queries, one per line (up to 12)<textarea name="queries" rows="6" defaultValue={sub?.queries.map(q => q.query).join('\n') ?? ''} placeholder={'laptop under 60000\nlaptop under 60k\nbest laptop under 60k {year}'} required/></label>
    </div>
    <p className="muted small">Write <code>{'{year}'}</code> where the year goes. It becomes {new Date().getFullYear()} now and updates itself every January.</p>
    {error && <p className="error">{error}</p>}
    <div className="row end"><button type="button" className="btn" onClick={onCancel}>Cancel</button><button className="btn primary">Save</button></div>
  </form>;
}

const shortDate = d => { const t = new Date(d); return t.toLocaleDateString('en-IN', {day:'numeric', month:'short', ...(t.getFullYear() !== new Date().getFullYear() && {year:'2-digit'})}); };
const fresh = d => { const days = (Date.now() - new Date(d)) / 864e5; return days < 14 ? 'new' : days < 90 ? '' : 'old'; };
// Your chosen channel's newest video found in this budget's search results.
function LatestVideo({l, ch}) {
  const v = l?.[ch.id];
  if (!v) return <span className="lv none"><span className="lv-date">—</span><span className="lv-t muted">No {ch.name} video found</span></span>;
  return <a className={'lv '+fresh(v.date)} href={'https://youtu.be/'+v.id} target="_blank" rel="noreferrer" title={v.title}>
    <span className="lv-date">{shortDate(v.date)}</span><span className="lv-t">{v.title}</span><span className="lv-ago muted">{ago(v.date)}</span></a>;
}

function BudgetRow({s, cat, rk, busy, open, onToggle, onCheck, onEdit, onDelete, onMute, lvCh}) {
  const done = s.queries.filter(q => q.ts && !q.error);
  const inTop = done.filter(q => q.rank != null && q.rank <= rk.top).length;
  const need = Math.floor(done.length / 2) + 1;
  const ch = cat.channel_name;
  const v = !done.length ? ['', 'Not checked'] : s.status === 'missing' ? ['bad', 'Not ranking'] : s.status === 'weak' ? ['warn', 'Needs work'] : ['good', 'On target'];
  return <>
    <tr className={'rank-tr'+(open ? ' open' : '')} onClick={onToggle}>
      <td><span className="chev-sm">{open ? '▾' : '▸'}</span><strong>{s.name}</strong></td>
      <td><span className={'status '+v[0]}><i/>{v[1]}</span></td>
      <td><span className="rank-pills">{s.queries.map(q => <span key={q.id} className={(q.muted ? 'rk muted-q ' : 'rk ')+rankClass(q.ts && !q.error ? q.rank : undefined)} title={`${q.text}: ${rankText(q)}`}>{q.error ? '!' : q.rank ?? '–'}</span>)}</span></td>
      <td className="latest-td" onClick={e => e.stopPropagation()}>{lvCh && <LatestVideo l={s.latest} ch={lvCh}/>}</td>
      <td className="num">{done.length ? <><strong>{inTop}</strong><span className="muted">/{done.length}</span>{inTop < need && <span className="muted small"> · need {need}</span>}</> : '—'}</td>
    </tr>
    {open && <tr className="rank-detail-tr"><td colSpan="5">
      <BudgetMetrics s={s} top={rk.top}/>
      <table className="qtable"><tbody>{s.queries.map(q => <React.Fragment key={q.id}><tr className={q.muted ? 'q-muted' : ''}>
        <td><a href={'https://www.youtube.com/results?search_query='+encodeURIComponent(q.text)} target="_blank" rel="noreferrer">{q.text}</a>{q.dynamic && <span className="auto" title="Year updates automatically">auto-year</span>}
          <span className="q-actions"><button className="link-btn" onClick={() => onMute(q)} title={q.muted ? 'Check this search again' : 'Stop checking this search and ignore it in scores and alerts'}>{q.muted ? 'Unmute' : 'Mute'}</button></span></td>
        <td className="num"><span className={'rk '+rankClass(q.ts && !q.error ? q.rank : undefined)}>{rankText(q)}</span><RankChange history={q.history}/></td>
        <td className="lead">{q.ts && !q.error && q.top[0] && (q.top[0].own
          ? <a className="ahead own" href={'https://youtu.be/'+q.top[0].id} target="_blank" rel="noreferrer" title={q.top[0].title}><b>#1</b><span className="ah-ch">{ch}</span><span className="ah-t">{q.top[0].title}</span></a>
          : <div className="aheads">{q.top.filter((t, i) => i < Math.min(3, (q.rank ?? 99) - 1)).map((t, i) => <a key={t.id} className="ahead" href={'https://youtu.be/'+t.id} target="_blank" rel="noreferrer" title={t.title}>
              <b>#{i+1}</b><span className="ah-ch">{t.channel}</span><span className="ah-t">{t.title}</span>{t.views ? <span className="ah-v">{short(t.views)}</span> : null}</a>)}
            {q.video && <a className="ahead own" href={'https://youtu.be/'+q.video} target="_blank" rel="noreferrer"><b>#{q.rank}</b><span className="ah-ch">{ch}</span><span className="ah-t">your video</span></a>}</div>)}</td>
      </tr></React.Fragment>)}</tbody></table>
      <div className="row end small-actions"><span className="muted small">{s.checked_at ? 'Checked '+ago(s.checked_at) : ''}</span>
        <button className="link-btn" onClick={onEdit}>Edit queries</button><button className="link-btn danger" onClick={onDelete}>Delete</button>
        <button className="btn" disabled={busy} onClick={onCheck}>{busy ? <span className="spinner"/> : 'Re-check'}</button></div>
    </td></tr>}
  </>;
}

function Rankings({data, own, call, setNotice, undo}) {
  const rk = data.rankings;
  const [catId, setCatId] = useState(rk.categories[0]?.id);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(null);
  const cat = rk.categories.find(c => c.id === catId) ?? rk.categories[0];
  const run = async (k, fn) => { setBusy(k); try { await fn(); } catch (err) { setNotice(err.message); } finally { setBusy(null); } };
  const w = rk.worker, man = w.manual;
  const check = body => run('check', () => call('/api/rankings/check', {method:'POST', body:JSON.stringify(body)}));
  // Poll while something is being checked so progress moves.
  useEffect(() => { if (!man && !w.current) return; const id = setInterval(() => call('/api/dashboard').catch(() => {}), 5000); return () => clearInterval(id); }, [!!man, !!w.current]);
  const [, tickR] = useState(0);
  useEffect(() => { const id = setInterval(() => tickR(t => t + 1), 1000); return () => clearInterval(id); }, []);
  const secsTo = t => Math.max(0, Math.round((new Date(t) - Date.now()) / 1000));
  const when = t => { const n = secsTo(t); return n < 90 ? n+'s' : Math.round(n/60)+' min'; };
  const saveSub = async body => { await call('/api/rankings/subcategories', {method:'POST', body:JSON.stringify(body)}); setEditing(null); };
  async function addCategory(e) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const res = await call('/api/rankings/categories', {method:'POST', body:JSON.stringify({name:d.get('name'), channel:Number(d.get('channel'))})}).catch(err => setNotice(err.message));
    if (res) { setCatId(res.rankings.categories.at(-1)?.id); setEditing(null); }
  }
  const subs = cat?.subs ?? [];
  const queries = subs.flatMap(s => s.queries).filter(q => q.ts && !q.error);
  const lastCheck = subs.map(s => s.checked_at).filter(Boolean).sort().at(-1);
  const count = st => subs.filter(s => s.status === st).length;
  const editSub = subs.find(s => s.id === editing);
  // Which of your channels the "Latest video" column shows; defaults to the category's channel.
  const [lvPick, setLvId] = useState(null);
  const lvCh = own.find(o => o.id === lvPick) ?? own.find(o => o.id === cat?.channel) ?? own[0];

  return <>
    <div className="toolbar spread">
      <div className="row">
        <div className="seg" role="tablist" aria-label="Category">{rk.categories.map(c => <button key={c.id} role="tab" aria-pressed={c.id === cat?.id} onClick={() => setCatId(c.id)}>{c.important ? <span className="imp-star" aria-label="Important">★</span> : null}{c.name}</button>)}</div>
        <button className="link-btn" onClick={() => setEditing('category')}>+ Category</button>
      </div>
      <div className="row"><span className="muted small">{lastCheck ? 'Checked '+ago(lastCheck) : 'Not checked'}</span>
        {cat && <button className="btn primary" disabled={!!busy || !!man || !!w.pausedUntil} onClick={() => check({category:cat.id})}>{man && man.category === cat.id ? <><span className="spinner"/>Checking…</> : 'Check '+cat.name+' now'}</button>}</div>
    </div>
    {editing === 'category' && <form className="editor" onSubmit={addCategory}><div className="fields">
      <label>Category<input name="name" placeholder="e.g. Smartphone" required maxLength="80"/></label>
      <label>Track channel<select name="channel">{own.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    </div><div className="row end"><button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button><button className="btn primary">Add category</button></div></form>}

    <div className={'worker-strip'+(w.pausedUntil ? ' paused' : '')}>
      {w.pausedUntil ? <><span className="conn-dot"/><span><b>Paused.</b> YouTube is limiting searches. Resumes in {when(w.pausedUntil)}, then backs off further if it keeps happening.</span></>
      : man ? <><span className="spinner"/><span><b>Checking {rk.categories.find(c => c.id === man.category)?.name}</b> · {man.done} / {man.total} searches</span><span className="wbar"><i style={{width:(man.total ? man.done/man.total*100 : 0)+'%'}}/></span></>
      : <><span className={'sync-dot'+(w.current ? ' live' : '')}/><span><b>Auto-check</b> · {fmt(w.checkedToday)} / {fmt(w.total)} searches in the last 24h · about 1 every {w.paceSeconds < 90 ? w.paceSeconds+'s' : Math.round(w.paceSeconds/60)+' min'}
        {w.current ? <> · now: {w.current.name} ({w.current.done}/{w.current.total})</> : w.nextAt ? <> · next in {when(w.nextAt)}</> : null}</span>
        <span className="wbar"><i style={{width:(w.total ? w.checkedToday/w.total*100 : 0)+'%'}}/></span></>}
      <span className="muted small wnote">★ Important categories are checked every {w.importantHours}h, others every {w.normalHours}h · ~{w.perHour} searches/hour
        {w.behind ? <b className="warn"> · Too many searches for a safe pace: checks are running about {w.behind}× slower than scheduled. Unmark some categories or remove queries.</b> : null}</span>
    </div>
    {cat ? <section className="card cat-card" key={cat.id}>
      <div className="card-head">
        <div><h2>{cat.name} · {cat.channel_name}</h2>
          <span className="muted">{count('strong')} of {subs.length} on target · {queries.length ? Math.round(queries.filter(q => q.rank != null && q.rank <= rk.top).length/queries.length*100) : 0}% of searches in top {rk.top}{count('missing') ? ` · ${count('missing')} not ranking` : ''}</span></div>
        <button className={'btn imp-btn'+(cat.important ? ' on' : '')} disabled={busy === 'imp'} aria-pressed={!!cat.important}
          title={cat.important ? 'Checked every '+w.importantHours+'h. Click to return to every '+w.normalHours+'h.' : 'Check this category every '+w.importantHours+'h instead of every '+w.normalHours+'h'}
          onClick={() => run('imp', () => call('/api/rankings/categories/'+cat.id+'/important', {method:'POST', body:JSON.stringify({important:!cat.important})}))}>
          {busy === 'imp' ? <span className="spinner"/> : cat.important ? '★' : '☆'}{cat.important ? 'Important · every '+w.importantHours+'h' : 'Mark as Important'}</button>
        <div className="legend"><span className="rk rk-top">1–2</span><span className="rk rk-mid">3–5</span><span className="rk rk-low">6+</span><span className="rk rk-none">–</span><span className="muted">not in top 20</span></div>
      </div>
      {editSub && <SubEditor sub={editSub} category={cat.id} onSave={saveSub} onCancel={() => setEditing(null)}/>}
      <div className="table-wrap"><table className="rank-table">
        <thead><tr><th>Budget</th><th>Status</th><th>Position per search</th><th className="lv-th"><span>Latest video of</span><select value={lvCh?.id ?? ''} onChange={e => setLvId(Number(e.target.value))} aria-label="Channel for latest video">{own.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></th><th className="num">In top {rk.top}</th></tr></thead>
        <tbody>{subs.map(s => <BudgetRow key={s.id} s={s} cat={cat} rk={rk} open={open === s.id} onToggle={() => setOpen(o => o === s.id ? null : s.id)}
          lvCh={lvCh} busy={!!man || !!busy || !!w.pausedUntil} onCheck={() => check({sub:s.id})}
          onMute={q => call('/api/rankings/queries/'+q.id+'/mute', {method:'POST', body:JSON.stringify({muted:!q.muted})}).then(() => toast(q.muted ? 'Search unmuted' : 'Search muted. It won’t be checked or alerted on.', {ttl:3000})).catch(err => toast(err.message, {kind:'error'}))} onEdit={() => setEditing(s.id)}
          onDelete={() => { setOpen(null); undo('sub:'+s.id, 'Deleted '+s.name, () => call('/api/rankings/subcategories/'+s.id, {method:'DELETE'})); }}/>)}</tbody>
      </table></div>
      {editing === 'new' && <SubEditor category={cat.id} onSave={saveSub} onCancel={() => setEditing(null)}/>}
      <div className="row card-foot"><button className="link-btn" onClick={() => setEditing('new')}>+ Add budget</button>
        <button className="link-btn danger" onClick={() => { setCatId(null); undo('cat:'+cat.id, 'Deleted the '+cat.name+' category', () => call('/api/rankings/categories/'+cat.id, {method:'DELETE'})); }}>Delete category</button></div>
    </section> : <section className="card"><div className="spark-empty">No categories yet. Add one to start tracking search rankings.</div></section>}
    <RivalBoard rivals={rk.watchdog.rivals}/>
    <WatchdogPanel wd={rk.watchdog} rk={rk} cat={cat} call={call} busy={!!man || !!w.pausedUntil}/>
  </>;
}

// ---------- ranking watchdog ----------
const SEV = {critical:['Critical','sev-crit'], high:['High','sev-high'], medium:['Medium','sev-med'], info:['Info','sev-info']};
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

// Key numbers for one budget, computed from each search's recent checks.
function BudgetMetrics({s, top}) {
  const qs = s.queries.filter(q => !q.muted && q.ts && !q.error);
  if (!qs.length) return null;
  const weekAgo = Date.now() - 7 * 864e5;
  const then = q => q.week?.any ? q.week.then : undefined;
  const hasWeek = qs.some(q => q.week?.hasWeek), vs = hasWeek ? 'vs 7d' : 'since first check';
  const inTop = list => list.filter(r => r != null && r <= top).length;
  const nowRanks = qs.map(q => q.rank), oldRanks = qs.map(then);
  const avg = list => { const f = list.filter(r => r != null); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null; };
  const avgNow = avg(nowRanks), avgOld = avg(oldRanks.filter(r => r !== undefined));
  const firsts = nowRanks.filter(r => r === 1).length, found = nowRanks.filter(r => r != null).length;
  // Your video that ranks on the most searches.
  const mine = new Map(); qs.forEach(q => q.video && mine.set(q.video, (mine.get(q.video) ?? 0) + 1));
  const [bestId, bestN] = [...mine].sort((a, b) => b[1] - a[1])[0] ?? [];
  const bestTitle = bestId && qs.flatMap(q => q.top).find(t => t.id === bestId)?.title;
  // Channel above you most often here.
  const rivals = new Map();
  qs.forEach(q => q.top.forEach((t, i) => { if (!t.own && i < (q.rank ?? 99) - 1) rivals.set(t.channel, (rivals.get(t.channel) ?? 0) + 1); }));
  const [rival, rivalN] = [...rivals].sort((a, b) => b[1] - a[1])[0] ?? [];
  // How often positions changed between checks over the last week.
  let moves = 0, steps = 0;
  qs.forEach(q => { steps += q.week?.steps ?? 0; moves += q.week?.moves ?? 0; });
  const delta = (now, old, lowerBetter) => old == null || now == null || Math.abs(now - old) < (lowerBetter ? 0.05 : 1) ? null
    : <span className={(lowerBetter ? now < old : now > old) ? 'up-text' : 'down-text'}>{(lowerBetter ? now < old : now > old) ? '▲' : '▼'} {lowerBetter ? Math.abs(now - old).toFixed(1) : Math.abs(now - old)} {vs}</span>;
  const tiles = [
    ['In top '+top, <>{inTop(nowRanks)}<small>/{qs.length}</small></>, delta(inTop(nowRanks), inTop(oldRanks), false)],
    ['Average position', avgNow ? '#'+avgNow.toFixed(1) : '—', delta(avgNow, avgOld, true), found < qs.length ? (qs.length - found)+' not found' : null],
    ['Ranking #1', <>{firsts}<small>/{qs.length}</small></>, null, firsts ? null : 'no #1 spots'],
    ['Your best video', bestId ? <a className="bm-link" href={'https://youtu.be/'+bestId} target="_blank" rel="noreferrer" title={bestTitle}>{bestTitle ?? bestId}</a> : '—', null, bestId ? 'ranks on '+bestN+' of '+qs.length : 'none ranking'],
    ['Top rival here', rival ?? '—', null, rival ? 'above you on '+rivalN+' search'+(rivalN > 1 ? 'es' : '') : 'nobody above you'],
    ['Stability, 7 days', steps ? Math.round((1 - moves / steps) * 100)+'%' : '—', null, steps ? moves+' rank change'+(moves === 1 ? '' : 's') : 'not enough checks'],
  ];
  return <div className="bmetrics">{tiles.map(([label, value, d, sub]) => <div key={label} className="bm">
    <span className="kpi-label">{label}</span><strong className="bm-v">{value}</strong>
    <span className="bm-sub">{d}{d && sub ? ' · ' : ''}{sub}</span></div>)}</div>;
}

const yt = id => 'https://youtu.be/'+id;
function IncidentBody({i}) {
  const d = i.details ?? {};
  return <div className="inc-body">
    {d.queries && <ul className="inc-q">{d.queries.map(q => <li key={q.id}>
      <span className="inc-qt">“{q.text}”</span>
      <span className={'rk '+rankClass(q.rank ?? undefined)}>{q.rank ? '#'+q.rank : '–'}</span>
      {q.best && q.best < 99 && q.best !== q.rank ? <span className="muted small">best #{q.best}</span> : null}
      {q.ranks && <span className="muted small">{q.ranks.map(r => r ?? '–').join(' → ')}</span>}
      {q.takenBy ? <a className="inc-link" href={yt(q.takenBy.id)} target="_blank" rel="noreferrer">now #1: <b>{q.takenBy.channel}</b> · {q.takenBy.title}</a>
        : q.above?.[0] ? <a className="inc-link" href={yt(q.above[0].id)} target="_blank" rel="noreferrer">top: <b>{q.above[0].channel}</b> · {q.above[0].title}</a> : null}
    </li>)}</ul>}
    {d.videos?.[0]?.video && <ul className="inc-q">{d.videos.map(v => <li key={v.video.id}><a className="inc-link" href={yt(v.video.id)} target="_blank" rel="noreferrer"><b>{v.video.channel}</b> · {v.video.title}</a><span className="muted small">{v.video.age} · {short(v.video.views)} views · #{Math.min(...v.queries.map(q => q.pos))} on {v.queries.length} search{v.queries.length > 1 ? 'es' : ''}</span></li>)}</ul>}
    {d.videos?.[0]?.n && <ul className="inc-q">{d.videos.map(v => <li key={v.id}><a className="inc-link" href={yt(v.id)} target="_blank" rel="noreferrer">{v.title ?? v.id}</a><span className="muted small">ranks on {v.n} search{v.n > 1 ? 'es' : ''}</span></li>)}</ul>}
    {d.rivals && <ul className="inc-q">{d.rivals.map(r => <li key={r.channel}><b>{r.channel}</b><span className="muted small">above you on {r.count} of {d.of} searches</span></li>)}</ul>}
    {d.video && d.published && <p className="muted small"><a className="inc-link" href={yt(d.video)} target="_blank" rel="noreferrer">{d.title}</a> · published {new Date(d.published).toLocaleDateString('en-IN', {month:'short', year:'numeric'})} · score {d.from} → {d.to}. Consider a refreshed video for this budget.</p>}
  </div>;
}

function WatchdogPanel({wd, rk, cat, call, busy}) {
  const [scope, setScope] = usePref('wdScope', 'cat');
  const [openId, setOpenId] = useState(null);
  const [showResolved, setShowResolved] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [expanded, setExpanded] = usePref('wdOpen', false);
  const inCat = i => !cat || scope === 'all' || i.category === cat.id;
  const active = wd.incidents.filter(i => i.state !== 'resolved' && inCat(i));
  const resolved = wd.incidents.filter(i => i.state === 'resolved' && inCat(i));
  const count = sev => active.filter(i => i.severity === sev).length;
  const serious = active.filter(i => i.severity !== 'info'), info = active.filter(i => i.severity === 'info');
  const catName = id => rk.categories.find(c => c.id === id)?.name;
  const act = (path, body) => call(path, {method:'POST', body:JSON.stringify(body ?? {})}).catch(err => toast(err.message, {kind:'error'}));
  const row = i => <div key={i.id} className={'inc '+SEV[i.severity][1]+(i.state === 'pending' ? ' pending' : '')+(i.state === 'resolved' ? ' resolved' : '')+(openId === i.id ? ' open' : '')}>
    <button className="inc-head" onClick={() => setOpenId(o => o === i.id ? null : i.id)} aria-expanded={openId === i.id}>
      <span className="sev-dot"/>
      <span className="inc-title">{i.title.replace(/ · [^·]+ · [^·]+$/, '')}</span>
      <span className="inc-meta">
        <span className="chip">{catName(i.category)} · {i.sub_name}</span>
        {i.state === 'pending' ? <span className="chip pending-chip" title="Waiting for a second check to confirm">Confirming…</span>
          : i.state === 'resolved' ? <span className="muted small">resolved {ago(i.resolved)}</span>
          : <span className="muted small">since {ago(i.opened)}</span>}
        {i.snoozed && <span className="chip">Snoozed</span>}
      </span>
    </button>
    {openId === i.id && <div className="inc-detail">
      <IncidentBody i={i}/>
      {i.state !== 'resolved' && <div className="row end small-actions">
        <button className="link-btn" onClick={() => act('/api/rankings/incidents/'+i.id+'/snooze', {days:i.snoozed ? 0 : 7})}>{i.snoozed ? 'Unsnooze' : 'Snooze 7 days'}</button>
        <button className="btn" disabled={busy} onClick={() => act('/api/rankings/check', {sub:i.sub})}>Recheck now</button>
      </div>}
    </div>}
  </div>;
  const confirming = active.filter(i => i.state === 'pending').length;
  return <section className={'card watchdog'+(expanded ? '' : ' collapsed')}>
    <div className="card-head wd-head">
      <button className="wd-toggle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        <span className="chev-sm">{expanded ? '▾' : '▸'}</span><h2>Watchdog</h2>
        <span className="muted small">{serious.length ? serious.length+' incident'+(serious.length > 1 ? 's' : '')+(confirming ? ' · '+confirming+' confirming' : '') : 'All clear'}</span>
      </button>
      <div className="row">
        <span className="sev-pill sev-crit" title="Critical">{count('critical')} critical</span><span className="sev-pill sev-high" title="High">{count('high')} high</span><span className="sev-pill sev-med" title="Medium">{count('medium')} medium</span>
        {expanded && <div className="seg sm" role="group" aria-label="Incident scope">{[['cat', cat?.name ?? 'This category'], ['all','All']].map(([k, l]) => <button key={k} aria-pressed={scope === k} onClick={() => setScope(k)}>{l}</button>)}</div>}
      </div>
    </div>
    {expanded && <div className="wd-body">
    <p className="muted small wd-note">Drops are confirmed by a second check before you're alerted. Critical and high go to Discord/Slack; medium goes into the digest.</p>
    {serious.length ? <div className="inc-list">{serious.map(row)}</div> : <div className="spark-empty">All clear. No incidents{scope === 'cat' && cat ? ' in '+cat.name : ''}.</div>}
    {info.length > 0 && <>
      <button className="link-btn show-more" onClick={() => setShowInfo(v => !v)}>{showInfo ? 'Hide' : 'Show'} {info.length} info notice{info.length > 1 ? 's' : ''} (unstable searches, split videos)</button>
      {showInfo && <div className="inc-list">{info.map(row)}</div>}
    </>}
    {resolved.length > 0 && <>
      <button className="link-btn show-more" onClick={() => setShowResolved(v => !v)}>{showResolved ? 'Hide' : 'Show'} {resolved.length} resolved in the last 7 days</button>
      {showResolved && <div className="inc-list">{resolved.map(row)}</div>}
    </>}
    </div>}
  </section>;
}

function RivalBoard({rivals}) {
  if (!rivals.length) return null;
  const max = rivals[0].queries;
  return <section className="card">
    <div className="card-head"><div><h2>Rival board</h2><span className="muted">Channels ranking above you most often, across all categories</span></div></div>
    <div className="rivals">{rivals.map((r, n) => <div key={r.channel} className="rival">
      <span className="rival-n">{n + 1}</span>
      <div className="rival-main"><b>{r.channel}</b>{r.top && <a className="inc-link" href={yt(r.top.id)} target="_blank" rel="noreferrer">{r.top.title}</a>}</div>
      <div className="rival-stat"><span className="wbar"><i style={{width:r.queries / max * 100+'%'}}/></span><span className="muted small">{r.queries} searches · {r.firsts}× #1 · {r.budgets} budgets</span></div>
    </div>)}</div>
  </section>;
}


// ---------- settings ----------
const ALERT_KINDS = [['outlier','Outlier videos'],['ranking','Search rankings'],['milestone','Subscriber milestones'],['published','Planned video published']];
const SERVICE_INFO = {
  discord: {name:'Discord', color:'#5865f2', how:'Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL'},
  slack: {name:'Slack', color:'#e01e5a', how:'api.slack.com/apps → Create App → Incoming Webhooks → Add New Webhook to Workspace → Copy'}
};

function WebhookCard({id, cfg, call}) {
  const info = SERVICE_INFO[id];
  const [editing, setEditing] = useState(!cfg.configured);
  const [msg, setMsg] = useState(null); // {ok, text}
  const [busy, setBusy] = useState(null);
  const save = async (body, label) => {
    setBusy(label); setMsg(null);
    try { await call('/api/settings/'+id, {method:'POST', body:JSON.stringify(body)}); return true; }
    catch (err) { setMsg({ok:false, text:err.message}); return false; }
    finally { setBusy(null); }
  };
  async function submit(e) {
    e.preventDefault();
    const url = new FormData(e.currentTarget).get('url').trim();
    if (await save({url, enabled:true}, 'save')) { setEditing(false); setMsg({ok:true, text:'Saved. Send a test to confirm it works.'}); }
  }
  async function test() {
    setBusy('test'); setMsg(null);
    try { await call('/api/settings/'+id+'/test', {method:'POST'}); setMsg({ok:true, text:'Sent a connection message and a sample “Lost #1” alert. Check '+info.name+'.'}); }
    catch (err) { setMsg({ok:false, text:err.message}); }
    finally { setBusy(null); }
  }
  const toggleKind = k => save({kinds: cfg.kinds.includes(k) ? cfg.kinds.filter(x => x !== k) : [...cfg.kinds, k]}, 'kind');
  const status = !cfg.configured ? ['', 'Not connected'] : !cfg.enabled ? ['', 'Paused'] : cfg.lastError ? ['bad', 'Failing'] : ['good', 'Connected'];

  return <section className="card hook">
    <div className="card-head">
      <div className="hook-title"><span className="hook-logo" style={{background:info.color}}>{info.name[0]}</span><div><h2>{info.name}</h2><span className={'status '+status[0]}><i/>{status[1]}{cfg.lastSent ? ' · last sent '+ago(cfg.lastSent) : ''}</span></div></div>
      {cfg.configured && <label className="switch" title={cfg.enabled ? 'Pause' : 'Resume'}><input type="checkbox" checked={cfg.enabled} disabled={!!busy} onChange={e => save({enabled:e.target.checked}, 'toggle')}/><span/>{cfg.enabled ? 'On' : 'Off'}</label>}
    </div>
    {editing ? <form onSubmit={submit} className="hook-form">
      <label>Webhook URL<input name="url" type="url" required autoComplete="off" spellCheck="false" placeholder={cfg.hint} defaultValue=""/></label>
      <p className="muted small">Where to find it: {info.how}</p>
      <div className="row end">{cfg.configured && <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>}<button className="btn primary" disabled={busy === 'save'}>{busy === 'save' ? <span className="spinner"/> : 'Save'}</button></div>
    </form> : <>
      <div className="hook-url"><code>{cfg.masked}</code>{cfg.fromEnv && <span className="muted small">from DISCORD_WEBHOOK_URL</span>}
        <div className="row"><button className="link-btn" onClick={() => setEditing(true)}>Change</button>
          <button className="link-btn danger" onClick={() => ask(`Disconnect ${info.name}? Alerts will stop being sent there.`, 'Disconnect').then(ok => ok && save({url:''}, 'remove').then(() => setEditing(true)))}>Disconnect</button>
          <button className="btn" disabled={!!busy} onClick={test}>{busy === 'test' ? <span className="spinner"/> : 'Send test'}</button></div></div>
      <div className="kinds"><span className="kpi-label">Send these alerts</span>
        <div className="kind-list">{ALERT_KINDS.map(([k, label]) => <label key={k} className="check"><input type="checkbox" checked={cfg.kinds.includes(k)} disabled={!!busy} onChange={() => toggleKind(k)}/>{label}</label>)}</div></div>
    </>}
    {(msg || cfg.lastError) && <p className={'hook-msg '+((msg ? msg.ok : false) ? 'ok' : 'err')}>{msg ? msg.text : 'Last delivery failed: '+cfg.lastError}</p>}
  </section>;
}

function Settings({data, call}) {
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  return <>
    <div className="settings-grid">
      <WebhookCard id="discord" cfg={data.notifications.discord} call={call}/>
      <WebhookCard id="slack" cfg={data.notifications.slack} call={call}/>
    </div>
    <DigestCard cfg={data.notifications.digest} connected={data.notifications.discord.enabled || data.notifications.slack.enabled} call={call}/>
    <DisplayCard/>
    <section className="card">
      <div className="card-head"><div><h2>Desktop notifications</h2><span className="muted">Shown by this browser while the dashboard is open</span></div>
        {perm === 'default' && <button className="btn" onClick={() => Notification.requestPermission().then(setPerm)}>Enable</button>}
        {perm === 'granted' && <span className="status good"><i/>On</span>}
        {perm === 'denied' && <span className="muted small">Blocked. Allow notifications for this site in your browser settings.</span>}
        {perm === 'unsupported' && <span className="muted small">Not supported in this browser.</span>}
      </div>
    </section>
    <p className="muted small">Webhook URLs are stored only in your local database (data/dashboard.db) and are never shown in full again. Anyone with a webhook URL can post to that channel, so keep it private.</p>
  </>;
}

// ---------- planner ----------
function Planner({own, plans, onSave, onDelete}) {
  const [form, setForm] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [view, setView] = useState('list');
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const t = today();
  const chan = id => own.find(c => c.id === id);
  const items = plans.filter(p => filter === 'all' || String(p.channel) === filter);
  async function lookup(event) {
    event.preventDefault();
    const id = videoId(new FormData(event.currentTarget).get('url').trim());
    setError(''); setResult(null);
    if (!/^[\w-]{11}$/.test(id ?? '')) { setError('Enter a valid YouTube video link or ID.'); return; }
    setBusy(true);
    try { setResult(await fetchVideo(id)); } catch (err) { setError(err.message || 'Video lookup failed.'); } finally { setBusy(false); }
  }
  const newPlan = (extra = {}) => setForm({title:'', channel:filter === 'all' ? own[0]?.id : Number(filter), format:'Long-form', status:'Idea', date:'', ...extra});
  async function submit(event) {
    event.preventDefault();
    const d = Object.fromEntries(new FormData(event.currentTarget));
    try { await onSave({...form, ...d, channel:Number(d.channel)}); setForm(null); } catch (err) { setError(err.message); }
  }
  // Calendar grid: weeks starting Monday.
  const start = new Date(month); start.setDate(1 - (month.getDay()+6)%7);
  const cells = Array.from({length:42}, (_, i) => { const d = new Date(start); d.setDate(start.getDate()+i); return d; });
  const key = d => d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  return <>
    <section className="card">
      <div className="card-head"><h2>Video lookup</h2><span className="muted">Any public video</span></div>
      <form className="lookup" onSubmit={lookup}><input name="url" aria-label="YouTube URL or video ID" placeholder="Paste a YouTube link or video ID" required/><button className="btn primary" disabled={busy}>{busy ? 'Looking up…' : 'Fetch video'}</button></form>
      {error && <p className="error" role="alert">{error}</p>}
      {result && <div className="result">{result.thumbnail && <img decoding="async" loading="lazy" {...thumbProps(result.thumbnail, '320px')} alt="" referrerPolicy="no-referrer"/>}<div>
        <a className="video-title" href={'https://www.youtube.com/watch?v='+result.id} target="_blank" rel="noreferrer">{result.title}</a>
        <p className="muted">{[result.channel, result.views && fmt(result.views)+' views', result.seconds && duration(result.seconds), result.published].filter(Boolean).join(' · ')}</p>
        <button className="btn" onClick={() => newPlan({title:result.title, youtube_id:result.id})}>Add to planner</button>
      </div></div>}
    </section>
    <section className="card">
      <div className="card-head"><div><h2>Upload planner</h2><span className="muted">{['Idea','In production','Scheduled','Published'].map(s => items.filter(v => v.status === s).length+' '+s.toLowerCase()).join(' · ')} · auto-marked Published when the video goes live</span></div>
        <div className="row">
          <div className="seg" role="group" aria-label="View">{['list','calendar'].map(v => <button key={v} aria-pressed={view===v} onClick={() => setView(v)}>{v === 'list' ? 'List' : 'Calendar'}</button>)}</div>
          <select aria-label="Filter by channel" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All channels</option>{own.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <button className="btn primary" onClick={() => newPlan()}>+ Add video</button>
        </div>
      </div>
      {form && <form className="editor" key={form.id || 'new'} onSubmit={submit}>
        <div className="fields">
          <label className="wide">Title<input name="title" defaultValue={form.title} required maxLength="150"/></label>
          <label>Channel<select name="channel" defaultValue={form.channel}>{own.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>Format<select name="format" defaultValue={form.format}>{['Long-form','Short'].map(s => <option key={s}>{s}</option>)}</select></label>
          <label>Status<select name="status" defaultValue={form.status}>{['Idea','In production','Scheduled','Published'].map(s => <option key={s}>{s}</option>)}</select></label>
          <label>Publish date<input type="date" name="date" defaultValue={form.date ?? ''}/></label>
          <label className="wide">Notes<input name="notes" defaultValue={form.notes ?? ''} maxLength="1000"/></label>
        </div>
        <div className="row end"><button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button>{form.id && <button type="button" className="btn danger" onClick={() => { onDelete(form.id); setForm(null); }}>Delete</button>}<button className="btn primary">Save video</button></div>
      </form>}
      {view === 'list' ? (items.length ? <div className="table-wrap"><table>
        <thead><tr><th>Title</th><th>Channel</th><th>Format</th><th>Status</th><th>Publish date</th><th/></tr></thead>
        <tbody>{items.map(v => <tr key={v.id}>
          <td className="title-cell">{v.youtube_id ? <a href={'https://www.youtube.com/watch?v='+v.youtube_id} target="_blank" rel="noreferrer">{v.title}</a> : v.title}{v.notes && <span className="muted small"> · {v.notes}</span>}</td>
          <td><span className="dot" style={{background:chan(v.channel)?.color}}/>{chan(v.channel)?.name ?? '—'}</td><td>{v.format}</td>
          <td><span className={'badge s'+['Idea','In production','Scheduled','Published'].indexOf(v.status)}>{v.status}</span></td>
          <td className={v.date && v.date < t && v.status !== 'Published' ? 'overdue' : ''}>{v.date || '—'}</td>
          <td><button className="btn ghost" onClick={() => setForm(v)}>Edit</button></td>
        </tr>)}</tbody>
      </table></div> : <p className="muted">No videos planned yet.</p>) : <div className="cal">
        <div className="cal-head"><button className="btn ghost" onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth()-1, 1))}>←</button><strong>{month.toLocaleDateString('en-IN', {month:'long', year:'numeric'})}</strong><button className="btn ghost" onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth()+1, 1))}>→</button>
          <span className="muted small">{items.filter(p => !p.date).length} unscheduled</span></div>
        <div className="cal-grid">{['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => <span key={d} className="cal-dow">{d}</span>)}
          {cells.map(d => { const k = key(d); return <div key={k} className={'cal-cell'+(d.getMonth() !== month.getMonth() ? ' out' : '')+(k === t ? ' today' : '')} onDoubleClick={() => newPlan({date:k})}>
            <span className="cal-day">{d.getDate()}</span>
            {items.filter(p => p.date === k).map(p => <button key={p.id} className={'cal-item s'+['Idea','In production','Scheduled','Published'].indexOf(p.status)} style={{'--c':chan(p.channel)?.color}} onClick={() => setForm(p)} title={p.title}>{p.title}</button>)}
          </div>; })}
        </div>
        <p className="muted small">Double-click a day to plan a video on it.</p>
      </div>}
    </section>
  </>;
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
  }
  const reload = () => api('/api/dashboard').then(d => {
    apply(d);
    if (connRef.current !== 'ok') toast('Back online. Data is up to date.', {kind:'ok'});
    connRef.current = 'ok'; attempt.current = 0; setConn('ok'); setRetryIn(-1);
  }).catch(err => {
    if (err.kind === 'http') return toast(err.message, {kind:'error'});
    connRef.current = navigator.onLine === false ? 'offline' : 'down'; setConn(connRef.current);
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
  const titles = {nodes:'Nodes', database:'Database health', settings:'Settings', rankings:'Search rankings', overview:'Overview', competitors:'Competitors', insights:'Insights', report:'Weekly report', alerts:'Alerts', planner:'Planner'};
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
    ...Object.entries({overview:'Overview', insights:'Insights', rankings:'Search rankings', report:'Weekly report', alerts:'Alerts', settings:'Settings', database:'Database health', nodes:'Nodes', planner:'Planner & lookup'}).map(([k, l]) => ({group:'Pages', label:l, run:() => setPage(k)})),
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
      <div className="brand"><span className="logo">▶</span>Channel Studio</div>
      <nav aria-label="Main">
        <span className="nav-label">Dashboard</span>
        {nav('overview', 'Overview', <span className="nav-icon">◧</span>)}
        {nav('insights', 'Insights', <span className="nav-icon">◔</span>)}
        {nav('rankings', 'Rankings', <span className="nav-icon">#</span>, data?.rankings.categories.flatMap(c => c.subs).filter(s => s.status === 'weak' || s.status === 'missing').length, true)}
        {nav('report', 'Weekly report', <span className="nav-icon">▤</span>)}
        {nav('alerts', 'Alerts', <span className="nav-icon">◉</span>, data?.unread, true)}
        <span className="nav-label">Your channels</span>
        {own.map(c => <React.Fragment key={c.id}>{nav('ch:'+c.id, c.name, <Avatar channel={c} size={22}/>)}</React.Fragment>)}
        <span className="nav-label">Competitors</span>
        {own.map(o => <React.Fragment key={o.id}>{nav('competitors:'+o.id, o.name+' rivals', <span className="nav-icon" style={{color:o.color}}>⚑</span>, o.rivals)}</React.Fragment>)}
        <span className="nav-label">Tools</span>
        {nav('settings', 'Settings', <span className="nav-icon">⚙</span>)}
        {nav('database', 'Database', <span className="nav-icon">◫</span>)}
        {nav('nodes', 'Nodes', <span className="nav-icon">⧉</span>)}
        {nav('planner', 'Planner & lookup', <span className="nav-icon">☰</span>, data?.plans.filter(p => p.status !== 'Published').length)}
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
          <button className="btn search-btn" onClick={() => setPalette(true)} aria-label="Search (Ctrl+K)"><span>⌕</span><span className="sb-text">Search</span><kbd>Ctrl K</kbd></button>
          <ThemeButton/>
          <button className="btn icon" onClick={() => setPage('alerts')} aria-label={'Alerts'+(data?.unread ? ', '+data.unread+' unread' : '')}>◉{data?.unread ? <span className="bell">{data.unread}</span> : null}</button>
          <button className="btn primary" onClick={refresh} disabled={refreshing || status?.running}>{refreshing || status?.running ? <><span className="spinner"/>Updating</> : '↻ Update now'}</button>
        </div>
      </header>
      <ConnectionBanner conn={conn} retryIn={retryIn} stale={status?.lastRun?.finished_at} onRetry={() => { attempt.current = 0; setRetryIn(0); }}/>
      {!data && <PageSkeleton/>}
      <Boundary resetKey={page}><div key={page} className="page-enter">
      {data && page === 'overview' && <Overview own={own} open={setPage} rail={<OverviewRail data={data} own={own} competitors={competitors} open={setPage} onRefresh={refresh} onSearch={() => setPalette(true)}/>}/>}
      {data && page === 'insights' && <Insights channels={data.channels}/>}
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
      </div></Boundary>
    </main>
  </div>;
}

// Sliding highlight for every segmented control: measures the pressed button and moves one pill to it.
function placeSeg(seg, animate = true) {
  const on = seg.querySelector(':scope > [aria-pressed=true]');
  if (!on) { seg.style.setProperty('--sw', '0px'); return; }
  if (!animate) seg.classList.add('seg-still');
  seg.style.setProperty('--sx', on.offsetLeft+'px'); seg.style.setProperty('--sw', on.offsetWidth+'px');
  seg.style.setProperty('--sy', on.offsetTop+'px'); seg.style.setProperty('--sh', on.offsetHeight+'px');
  seg.classList.add('seg-ready');
  if (!animate) requestAnimationFrame(() => requestAnimationFrame(() => seg.classList.remove('seg-still')));
}
if (typeof document !== 'undefined') {
  new MutationObserver(list => {
    const segs = new Set();
    for (const m of list) {
      if (m.type === 'attributes') { const seg = m.target.parentElement; if (seg?.classList.contains('seg')) segs.add(seg); }
      else for (const n of m.addedNodes) if (n.nodeType === 1) (n.classList.contains('seg') ? [n] : n.querySelectorAll('.seg')).forEach(x => placeSeg(x, false));
    }
    segs.forEach(x => placeSeg(x));
  }).observe(document.documentElement, {subtree:true, childList:true, attributes:true, attributeFilter:['aria-pressed']});
  addEventListener('resize', () => document.querySelectorAll('.seg').forEach(x => placeSeg(x, false)));
  document.fonts?.ready.then(() => document.querySelectorAll('.seg').forEach(x => placeSeg(x, false)));
}

// Soft spotlight that follows the pointer over cards.
if (typeof document !== 'undefined') document.addEventListener('pointermove', e => {
  const el = e.target.closest?.('.card,.kpi'); if (!el) return;
  const b = el.getBoundingClientRect(); el.style.setProperty('--mx', (e.clientX - b.left)+'px'); el.style.setProperty('--my', (e.clientY - b.top)+'px');
}, {passive:true});


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
    <div><strong>{n ? 'Via '+n.name : 'Finding a node…'}</strong>
      <span>{n ? (n.ms != null ? n.ms+' ms · ' : '')+r.nodes.filter(x => x.ms != null).length+' node'+(r.nodes.filter(x => x.ms != null).length === 1 ? '' : 's')+' online' : 'connecting'}</span>
      <span className="row" style={{gap:10}}><button className="link-btn" disabled={busy} onClick={switchNode}>{busy ? 'Checking…' : 'Re-check'}</button><button className="link-btn" onClick={() => signOut()}>Sign out</button></span></div>
  </div>;
}
function Root() {
  const r = useRemote();
  if (REMOTE && !r.signedIn) return <SignIn/>;
  return <App/>;
}

createRoot(document.getElementById('root')).render(<Root/>);
