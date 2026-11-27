// Google Trends: Explore (interest over time, by subregion, related topics and queries for up to 5 terms)
// and Trending now (what is spiking in a country). Numbers are Google's relative 0–100 scale, not search counts.
// Data comes from a node first (/api/trends/*). If no node can answer, the Vercel site asks Google itself
// (api/trends.js), which Google limits more often.
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {api, usePref} from '../shared.jsx';
import {REMOTE, pass} from '../remote.js';

const COLORS = ['#4c8dff', '#ff6b6b', '#ffb340', '#3ccf8e', '#b57bff'];
const GEOS = [['IN', 'India'], ['', 'Worldwide'], ['US', 'United States'], ['GB', 'United Kingdom'], ['CA', 'Canada'], ['AU', 'Australia'], ['AE', 'UAE'], ['SG', 'Singapore']];
const TIMES = [['now 1-H', 'Past hour'], ['now 4-H', 'Past 4 hours'], ['now 1-d', 'Past day'], ['now 7-d', 'Past 7 days'], ['today 1-m', 'Past 30 days'], ['today 3-m', 'Past 90 days'], ['today 12-m', 'Past 12 months'], ['today 5-y', 'Past 5 years']];
const PROPS = [['web', 'Web Search'], ['youtube', 'YouTube Search']];

// A node first; when none answers (or it fails), the Vercel function.
async function trendsGet(kind, params) {
  const qs = new URLSearchParams(params).toString();
  try { return await api(`/api/trends/${kind}?${qs}`); }
  catch (err) {
    if (!REMOTE || err.kind === 'auth' || err.status === 400) throw err;
    const r = await fetch(`/api/trends?kind=${kind}&${qs}`, {headers: {Authorization: 'Bearer ' + pass()}, signal: AbortSignal.timeout(15000)}).catch(() => null);
    const d = await r?.json().catch(() => null);
    if (!r?.ok) throw new Error(d?.error ?? err.message);
    return d;
  }
}

const NoData = () => <div className="gt-empty">Not enough searches to show here. Try a longer period.</div>;

export function TrendsPage() {
  const [tab, setTab] = usePref('trendsTab', 'explore');
  return <div className="gt">
    <div className="toolbar"><div className="seg" role="group" aria-label="View">
      {[['explore', 'Explore'], ['trending', 'Trending now']].map(([k, l]) => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}
    </div></div>
    {tab === 'explore' ? <Explore/> : <Trending/>}
  </div>;
}

// ---------- Explore ----------
function Explore() {
  const [s, setS] = usePref('trendsExplore', {terms: ['laptop under 50000'], geo: 'IN', time: 'now 1-d', prop: 'web'});
  const [d, setD] = useState(null), [err, setErr] = useState(null), [loading, setLoading] = useState(true);
  const [add, setAdd] = useState('');
  const key = JSON.stringify(s);
  useEffect(() => {
    let live = true; setLoading(true); setErr(null);
    trendsGet('explore', {q: s.terms.join(','), geo: s.geo, prop: s.prop, time: s.time})
      .then(x => live && setD(x), e => live && setErr(e.message)).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [key]);
  const set = patch => setS({...s, ...patch});
  const setTerm = (i, v) => { const t = [...s.terms]; v.trim() ? t[i] = v.trim() : t.splice(i, 1); if (t.length) set({terms: t}); };
  const search = q => set({terms: [q]});

  return <>
    <div className="gt-terms">
      {s.terms.map((t, i) => <div key={i + t} className="gt-term">
        <span className="gt-dot" style={{background: COLORS[i]}}/>
        <input defaultValue={t} aria-label={'Search term ' + (i + 1)} onBlur={e => e.target.value.trim() !== t && setTerm(i, e.target.value)} onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}/>
        {s.terms.length > 1 && <button className="gt-x" aria-label={'Remove ' + t} onClick={() => setTerm(i, '')}>×</button>}
      </div>)}
      {s.terms.length < 5 && <div className="gt-term add">
        <span className="gt-dot hollow"/>
        <input value={add} placeholder="+ Compare" aria-label="Add a search term to compare" onChange={e => setAdd(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && add.trim()) { set({terms: [...s.terms, add.trim()]}); setAdd(''); } }}/>
      </div>}
    </div>
    <div className="toolbar gt-filters">
      <select aria-label="Country" value={s.geo} onChange={e => set({geo: e.target.value})}>{GEOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <select aria-label="Period" value={s.time} onChange={e => set({time: e.target.value})}>{TIMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <div className="seg sm" role="group" aria-label="Search type">{PROPS.map(([v, l]) => <button key={v} aria-pressed={s.prop === v} onClick={() => set({prop: v})}>{l}</button>)}</div>
      {d && !loading && <span className="muted small gt-via">{d.via === 'vercel' ? 'Via the website (no node answered)' : 'Via a node'} · numbers are relative, 100 = busiest</span>}
    </div>
    {err && !loading ? <section className="card"><p className="down-text">{err}</p></section>
      : loading || !d ? <><section className="card"><div className="sk" style={{height: 300, borderRadius: 10}}/></section><div className="gt-grid"><section className="card"><div className="sk" style={{height: 220, borderRadius: 10}}/></section><section className="card"><div className="sk" style={{height: 220, borderRadius: 10}}/></section></div></>
      : <>
        <section className="card"><div className="gt-head"><h2>Interest over time</h2></div><Chart d={d}/></section>
        <section className="card"><div className="gt-head"><h2>Interest by subregion</h2></div><Regions d={d}/></section>
        <div className="gt-grid">
          <Related title="Related topics" d={d} lists={[d.topicsRising, d.topicsTop]} topics/>
          <Related title="Related queries" d={d} lists={[d.rising, d.top]} onPick={search}/>
        </div>
      </>}
  </>;
}

function Chart({d}) {
  const [hover, setHover] = useState(null);
  const svg = useRef(null);
  const pts = d.points, n = pts.length;
  if (!n || pts.every(p => p.values.every(v => !v))) return <NoData/>;
  const W = 900, H = 280, L = 34, R = 10, T = 12, B = 30;
  const x = i => L + i * (W - L - R) / Math.max(1, n - 1), y = v => T + (100 - v) * (H - T - B) / 100;
  const long = pts.at(-1).t - pts[0].t > 3 * 864e5;
  const label = (t, full) => new Date(t).toLocaleString('en-IN', long ? {day: 'numeric', month: 'short', ...(full ? {year: 'numeric'} : {})} : {...(full ? {day: 'numeric', month: 'short'} : {}), hour: 'numeric', minute: '2-digit'});
  const step = Math.max(1, Math.round(n / 5));
  const move = e => { const r = svg.current.getBoundingClientRect(); const vx = (e.clientX - r.left) / r.width * W; setHover(Math.max(0, Math.min(n - 1, Math.round((vx - L) / (W - L - R) * (n - 1))))); };
  const p = hover != null ? pts[hover] : null;
  return <div className="gt-iot">
    {d.keywords.length > 1 && <div className="gt-avgs" aria-label="Average interest">
      {d.averages.map((a, k) => <div key={k} title={d.keywords[k] + ': ' + Math.round(a)}><i style={{height: Math.max(2, a / 100 * 210), background: COLORS[k]}}/><span>{Math.round(a)}</span></div>)}
    </div>}
    <div className="gt-chart">
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseMove={move} onMouseLeave={() => setHover(null)} role="img" aria-label="Interest over time">
        {[0, 25, 50, 75, 100].map(v => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeDasharray={v ? '2 3' : ''}/><text x={L - 8} y={y(v) + 4} fontSize="11" textAnchor="end" fill="var(--muted)">{v}</text></g>)}
        {pts.map((p, i) => i % step ? null : <text key={i} x={x(i)} y={H - 8} fontSize="11" textAnchor="middle" fill="var(--muted)">{label(p.t)}</text>)}
        {d.keywords.map((_, k) => <path key={k} d={pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.values[k]).toFixed(1)).join(' ')} fill="none" stroke={COLORS[k]} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>)}
        {p && <><line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="var(--muted)" vectorEffect="non-scaling-stroke"/>
          {d.keywords.map((_, k) => <circle key={k} cx={x(hover)} cy={y(p.values[k])} r="4" fill={COLORS[k]} stroke="var(--panel)" strokeWidth="2"/>)}</>}
      </svg>
      {p && <div className="gt-tip" style={{left: `min(calc(${x(hover) / W * 100}% + 12px), calc(100% - 200px))`}}>
        <b>{label(p.t, true)}{p.partial ? ' (partial)' : ''}</b>
        {d.keywords.map((kw, k) => <div key={k}><span className="gt-dot" style={{background: COLORS[k]}}/>{kw}<b>{p.values[k]}</b></div>)}
      </div>}
    </div>
  </div>;
}

function Regions({d}) {
  const [all, setAll] = useState(false);
  const rs = useMemo(() => [...d.regions].sort((a, b) => Math.max(...b.values) - Math.max(...a.values) || a.name.localeCompare(b.name)), [d]);
  if (!rs.length) return <NoData/>;
  const multi = d.keywords.length > 1;
  return <>
    <div className="gt-regions">{(all ? rs : rs.slice(0, 10)).map((r, i) => {
      const sum = r.values.reduce((a, b) => a + b, 0) || 1;
      return <div key={r.code || r.name} className="gt-reg">
        <span className="muted">{i + 1}</span><span className="gt-rname">{r.name}</span>
        <span className="gt-bar">{multi ? r.values.map((v, k) => <i key={k} title={d.keywords[k] + ': ' + v + '%'} style={{width: v / sum * 100 + '%', background: COLORS[k]}}/>) : <i style={{width: r.values[0] + '%', background: COLORS[0]}}/>}</span>
        <span className="muted gt-rv">{multi ? '' : r.values[0]}</span>
      </div>;
    })}</div>
    {multi && <p className="muted small">Colours show each term’s share of searches in that region.</p>}
    {rs.length > 10 && <button className="btn sm gt-more" onClick={() => setAll(!all)}>{all ? 'Show top 10' : `Show all ${rs.length}`}</button>}
  </>;
}

function Related({title, d, lists, topics, onPick}) {
  const [mode, setMode] = useState(0), [page, setPage] = useState(0);
  const items = lists[mode] ?? [], pages = Math.max(1, Math.ceil(items.length / 5)), pg = Math.min(page, pages - 1);
  return <section className="card">
    <div className="gt-head"><h2>{title}</h2>{d.keywords.length > 1 && <span className="muted small">{d.keywords[0]}</span>}
      <div className="seg sm" role="group" aria-label={title + ' order'}>{['Rising', 'Top'].map((l, i) => <button key={l} aria-pressed={mode === i} onClick={() => { setMode(i); setPage(0); }}>{l}</button>)}</div>
    </div>
    {!items.length ? <NoData/> : <>
      <ol className="gt-list">{items.slice(pg * 5, pg * 5 + 5).map((it, j) => <li key={it.query + j}>
        <span className="muted gt-n">{pg * 5 + j + 1}</span>
        <span className="gt-q">{topics ? <>{it.query}<small className="muted">{it.type}</small></> : <button className="gt-link" title="Explore this search" onClick={() => onPick(it.query)}>{it.query}</button>}</span>
        <span className={/^\+|Breakout/.test(it.value) ? 'up-text gt-v' : 'muted gt-v'}>{it.value}</span>
      </li>)}</ol>
      <div className="gt-pager muted small">{pg * 5 + 1}–{Math.min(items.length, pg * 5 + 5)} of {items.length}
        <button className="btn icon sm" disabled={!pg} aria-label="Previous" onClick={() => setPage(pg - 1)}>‹</button>
        <button className="btn icon sm" disabled={pg >= pages - 1} aria-label="Next" onClick={() => setPage(pg + 1)}>›</button>
      </div>
    </>}
  </section>;
}

// ---------- Trending now ----------
const agoM = t => { const m = Math.max(1, Math.round((Date.now() - t) / 6e4)); return m < 60 ? m + ' min ago' : Math.round(m / 60) + ' hr ago'; };
const vol = n => n >= 1e6 ? Math.round(n / 1e6) + 'M+' : n >= 1e3 ? Math.round(n / 1e3) + 'K+' : n + '+';
const SORTS = [['volume', 'Volume'], ['recent', 'Newest'], ['increase', 'Rising']];

function Trending() {
  const [geo, setGeo] = usePref('trendsGeo', 'IN');
  const [cat, setCat] = usePref('trendsCat', 'all');
  const [sort, setSort] = usePref('trendsSort', 'volume');
  const [active, setActive] = usePref('trendsActive', false);
  const [d, setD] = useState(null), [err, setErr] = useState(null), [q, setQ] = useState(''), [shown, setShown] = useState(50);
  useEffect(() => {
    let live = true; setD(null); setErr(null);
    const load = () => trendsGet('trending', {geo}).then(x => live && (setD(x), setErr(null)), e => live && setErr(e.message));
    load(); const t = setInterval(load, 5 * 60e3);
    return () => { live = false; clearInterval(t); };
  }, [geo]);
  const counts = useMemo(() => { const c = {}; for (const i of d?.items ?? []) for (const k of i.categories) c[k] = (c[k] ?? 0) + 1; return c; }, [d]);
  const cats = Object.entries(d?.categories ?? {}).filter(([k]) => counts[k]).sort((a, b) => counts[b[0]] - counts[a[0]]);
  const items = useMemo(() => {
    const l = (d?.items ?? []).filter(i => (cat === 'all' || i.categories.includes(+cat)) && (!active || !i.ended) &&
      (!q || (i.title + ' ' + i.terms.join(' ') + ' ' + i.news.map(n => n.title).join(' ')).toLowerCase().includes(q.toLowerCase())));
    return sort === 'recent' ? [...l].sort((a, b) => b.started - a.started) : sort === 'increase' ? [...l].sort((a, b) => (b.increase ?? 0) - (a.increase ?? 0)) : l;
  }, [d, cat, q, sort, active]);
  useEffect(() => setShown(50), [cat, q, sort, active, geo]);
  return <>
    <div className="toolbar gt-filters">
      <select aria-label="Country" value={geo} onChange={e => setGeo(e.target.value)}>{GEOS.filter(([v]) => v).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <select aria-label="Category" value={cat} onChange={e => setCat(e.target.value)}>
        <option value="all">All categories{d ? ' (' + d.items.length + ')' : ''}</option>
        {(cats.length ? cats : Object.entries(d?.categories ?? {})).map(([k, l]) => <option key={k} value={k}>{l}{counts[k] ? ' (' + counts[k] + ')' : ''}</option>)}
      </select>
      <div className="seg sm" role="group" aria-label="Sort">{SORTS.map(([k, l]) => <button key={k} aria-pressed={sort === k} onClick={() => setSort(k)}>{l}</button>)}</div>
      <label className="gt-check"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)}/> Active only</label>
      <input className="gt-filter" placeholder="Filter trends" aria-label="Filter trends" value={q} onChange={e => setQ(e.target.value)}/>
      {d && <span className="muted small gt-via">{items.length} trends · past 24 hours · {d.via === 'vercel' ? 'via the website' : 'via a node'}</span>}
    </div>
    {cats.length > 0 && <div className="gt-cats">
      <button className="gt-cat" aria-pressed={cat === 'all'} onClick={() => setCat('all')}>All</button>
      {cats.map(([k, l]) => <button key={k} className="gt-cat" aria-pressed={cat === k} onClick={() => setCat(k)}>{l} <span>{counts[k]}</span></button>)}
    </div>}
    {err && !d ? <section className="card"><p className="down-text">{err}</p></section>
      : !d ? <section className="card">{Array.from({length: 6}, (_, i) => <div key={i} className="sk" style={{height: 56, borderRadius: 10, margin: '10px 0'}}/>)}</section>
      : <section className="card gt-tbl">
        <div className="gt-row head"><span>Trend</span><span>Search volume</span><span>Started</span><span>Trend breakdown</span></div>
        {!items.length && <div className="gt-empty">No trends match.</div>}
        {items.slice(0, shown).map(i => <div key={i.title} className="gt-row">
          <div className="gt-t">{i.picture ? <img src={i.picture} alt="" loading="lazy" referrerPolicy="no-referrer"/> : <span className="gt-img">{i.title.slice(0, 1).toUpperCase()}</span>}
            <div><a href={'https://www.google.com/search?q=' + encodeURIComponent(i.title)} target="_blank" rel="noreferrer">{i.title}</a>
              <span className="muted small">{i.categories.map(c => d.categories[c]).filter(Boolean).join(' · ')}</span>
              {i.news[0] && <a className="gt-headline" href={i.news[0].url} target="_blank" rel="noreferrer" title={i.news[0].title}>{i.news[0].title} <span className="muted">· {i.news[0].source}</span></a>}</div></div>
          <div><b>{vol(i.volume)}</b>{i.increase ? <span className="up-text small">↑ {i.increase.toLocaleString('en-IN')}%</span> : <span className="muted small">searches</span>}</div>
          <div><span>{i.started ? agoM(i.started) : '—'}</span>{i.ended
            ? <span className="gt-badge old">Lasted {Math.max(1, Math.round((i.ended - i.started) / 36e5))} hr</span>
            : <span className="gt-badge">Active</span>}</div>
          <div className="gt-terms-cell">{i.terms.slice(0, 3).map(t => <span key={t} className="gt-chip" title={t}>{t}</span>)}
            {i.terms.length > 3 && <span className="muted small" title={i.terms.slice(3).join(', ')}>+{i.terms.length - 3} more</span>}</div>
        </div>)}
        {items.length > shown && <div className="gt-empty"><button className="btn sm" onClick={() => setShown(shown + 50)}>Show more ({items.length - shown} left)</button></div>}
      </section>}
  </>;
}
