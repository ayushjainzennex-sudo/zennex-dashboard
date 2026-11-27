// Topic research: find topic ideas from a seed (YouTube autocomplete, Google Trends, Trending now, competitor
// outliers) and check any of them on a 0–100 scorecard (demand, momentum, freshness gap, opening, spread).
// Data comes from a node first, the Vercel site if no node answers (without the database parts).
// Part of the topic-research feature: see RESEARCH.md for how to remove it.
import React, {useEffect, useMemo, useState} from 'react';
import {createPortal} from 'react-dom';
import {Avatar, api, fmt, toast, usePref} from '../shared.jsx';
import {Chart as TrendChart} from './trends.jsx';
import {REMOTE, pass} from '../remote.js';

async function get(kind, params) {
  const qs = new URLSearchParams(params).toString();
  try { return await api(`/api/research/${kind}?${qs}`); }
  catch (err) {
    if (!REMOTE || err.kind === 'auth' || err.status === 400) throw err;
    const r = await fetch(`/api/research?kind=${kind}&${qs}`, {headers: {Authorization: 'Bearer ' + pass()}, signal: AbortSignal.timeout(30000)}).catch(() => null);
    const d = await r?.json().catch(() => null);
    if (!r?.ok) throw new Error(d?.error ?? err.message);
    return d;
  }
}

const SOURCES = {'autocomplete': 'YouTube autocomplete', 'trends-rising': 'Trends rising', 'trends-top': 'Trends top', 'trending-now': 'Trending now'};
const TAGS = {'autocomplete': 'Search', 'trends-rising': 'Rising', 'trends-top': 'Trends', 'trending-now': 'Today'};
const GEO = 'IN';   // research is limited to India
const thumb = id => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const tone = v => v >= 70 ? 'var(--up)' : v >= 45 ? '#ffb340' : 'var(--down)';

export function ResearchPage({own = [], onOpen}) {
  const [s, setS] = usePref('research', {seed: 'laptop under 50000', geo: 'IN', pick: null, recent: []});
  const tab = s.tab ?? 'picks', cmp = s.compare ?? [];
  const [saved, setSaved] = useState(null), [savedErr, setSavedErr] = useState(null);
  useEffect(() => { api('/api/research/saved').then(setSaved, e => setSavedErr(e.message)); }, []);
  const savedOf = (q, geo) => saved?.find(x => x.q === q && x.geo === geo);
  const save = patch => api('/api/research/saved', {method: 'POST', body: JSON.stringify(patch)}).then(l => { setSaved(l); return l; }, e => toast(e.message));
  const unsave = (q, geo) => api('/api/research/saved/remove', {method: 'POST', body: JSON.stringify({q, geo})}).then(setSaved, e => toast(e.message));
  const toggleCompare = q => setS({...s, compare: cmp.includes(q) ? cmp.filter(x => x !== q) : [...cmp, q].slice(-5)});
  const [seed, setSeed] = useState(s.seed);
  const [d, setD] = useState(null), [err, setErr] = useState(null), [loading, setLoading] = useState(false);
  const [src, setSrc] = useState('all'), [filter, setFilter] = useState(''), [shown, setShown] = useState(120);
  const set = patch => setS({...s, ...patch});

  useEffect(() => {
    if (!s.seed) return;
    let live = true; setLoading(true); setErr(null); setD(null); setShown(40);
    get('ideas', {q: s.seed, geo: GEO}).then(x => live && setD(x), e => live && setErr(e.message)).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [s.seed, GEO]);

  const run = q => { q = q.trim().toLowerCase(); if (!q) return; setSeed(q); set({seed: q, pick: null, recent: [q, ...s.recent.filter(r => r !== q)].slice(0, 8)}); };
  const counts = useMemo(() => { const c = {}; for (const i of d?.ideas ?? []) for (const x of i.sources) c[x] = (c[x] ?? 0) + 1; return c; }, [d]);
  const list = useMemo(() => (d?.ideas ?? []).filter(i => (src === 'all' || i.sources.includes(src)) && (!filter || i.query.includes(filter.toLowerCase())))
    .sort((a, b) => b.sources.length - a.sources.length || (b.sources.includes('trends-rising') - a.sources.includes('trends-rising'))), [d, src, filter]);

  const tabs = <div className="toolbar rs-tabs"><div className="seg" role="group" aria-label="View">
    {[['picks', '✦ AI picks'], ['find', 'Find ideas'], ['saved', 'Saved' + (saved?.length ? ' · ' + saved.length : '')], ['compare', 'Compare' + (cmp.length ? ' · ' + cmp.length : '')]].map(([k, l]) =>
      <button key={k} aria-pressed={tab === k} onClick={() => set({tab: k})}>{l}</button>)}
  </div></div>;
  const card = q => <Scorecard q={q} geo={GEO} onPick={q => set({pick: q, tab: 'find'})} saved={savedOf(q, GEO)}
    onSave={(c, brief) => save({q, geo: GEO, total: c.total, verdict: c.verdict, ...(brief ? {brief} : {})})} onUnsave={() => unsave(q, GEO)}
    inCompare={cmp.includes(q)} onCompare={() => toggleCompare(q)}/>;
  if (tab === 'saved') return <div className="rs">{tabs}<Saved list={saved} err={savedErr} own={own} onOpenPlanner={() => onOpen?.('planner')}
    onOpen={x => set({tab: 'find', pick: x.q})} onSave={save} onRemove={x => unsave(x.q, x.geo)} onCompare={toggleCompare} cmp={cmp}/></div>;
  if (tab === 'picks') return <div className="rs">{tabs}<Picks onScore={p => set({tab: 'find', pick: p.topic})} onExplore={p => { setSeed(p.topic); set({tab: 'find', seed: p.topic, pick: p.topic, recent: [p.topic, ...s.recent.filter(r => r !== p.topic)].slice(0, 8)}); }}
    isSaved={p => !!savedOf(p.topic, GEO)} onSave={p => save({q: p.topic, geo: GEO, notes: p.title, pick: p})} channels={own}/></div>;
  if (tab === 'compare') return <div className="rs">{tabs}<Compare topics={cmp} geo={GEO} onRemove={toggleCompare} onOpen={q => set({tab: 'find', pick: q})}/></div>;
  return <div className="rs">
    {tabs}
    <form className="rs-search" onSubmit={e => { e.preventDefault(); run(seed); }}>
      <input value={seed} onChange={e => setSeed(e.target.value)} placeholder="Start with a topic, e.g. laptop under 50000" aria-label="Topic"/>
      <span className="muted small rs-geo">India</span>
      <button className="btn primary" disabled={loading}>{loading ? <><span className="spinner"/>Researching</> : 'Find ideas'}</button>
    </form>
    {s.recent.length > 1 && <div className="rs-recent"><span className="muted small">Recent</span>{s.recent.map(r => <button key={r} className="gt-cat" aria-pressed={r === s.seed} onClick={() => run(r)}>{r}</button>)}</div>}

    <div className="rs-layout">
      <div className="rs-main">
        <section className="card rs-ideas">
          <div className="gt-head"><h2>Ideas</h2>{d && <span className="muted small">{list.length} of {d.ideas.length} · click one to score it</span>}</div>
          {d && <div className="rs-filters">
            <div className="gt-cats" style={{padding: 0}}>
              <button className="gt-cat" aria-pressed={src === 'all'} onClick={() => setSrc('all')}>All <span>{d.ideas.length}</span></button>
              {Object.entries(SOURCES).filter(([k]) => counts[k]).map(([k, l]) => <button key={k} className="gt-cat" aria-pressed={src === k} onClick={() => setSrc(k)}>{l} <span>{counts[k]}</span></button>)}
            </div>
            <input placeholder="Filter ideas" aria-label="Filter ideas" value={filter} onChange={e => setFilter(e.target.value)}/>
          </div>}
          {err ? <p className="down-text">{err}</p>
            : !d ? Array.from({length: 8}, (_, i) => <div key={i} className="sk" style={{height: 34, borderRadius: 8, margin: '8px 0'}}/>)
            : !list.length ? <div className="gt-empty">No ideas match.</div>
            : <ol className="rs-list">{list.slice(0, shown).map(i => <li key={i.query}>
                <button className={'rs-idea' + (s.pick === i.query ? ' on' : '')} onClick={() => set({pick: i.query})}>
                  <span className="rs-q">{i.query}</span>
                  <span className="rs-tags">
                    {i.rising && <span className="up-text small">{i.rising}</span>}
                    {i.trendVolume && <span className="small rs-tag hot">trending {fmt(i.trendVolume)}+</span>}
                    {i.sources.map(x => <span key={x} className={'rs-tag s-' + x} title={SOURCES[x]}>{TAGS[x]}</span>)}
                  </span>
                </button>
              </li>)}</ol>}
          {list.length > shown && <button className="btn sm" onClick={() => setShown(shown + 120)}>Show more ({list.length - shown} left)</button>}
          {d && Object.keys(d.errors ?? {}).length > 0 && <p className="muted small">Missing: {Object.entries(d.errors).map(([k, v]) => k + ' (' + v + ')').join(', ')}</p>}
        </section>
        {d?.outliers?.length > 0 && <section className="card">
          <div className="gt-head"><h2>Competitor hits on this topic</h2><span className="muted small">well above that channel’s usual views</span></div>
          <div className="rs-vids">{d.outliers.map(v => <Video key={v.id} v={v} onPick={() => set({pick: v.title.toLowerCase().slice(0, 100)})}/>)}</div>
        </section>}
      </div>
      <aside className="rs-side">
        {s.pick ? card(s.pick)
          : <section className="card rs-hint"><h2>Pick an idea</h2><p className="muted">Click any idea on the left to see its scorecard: how much people watch it, whether interest is rising, and whether a new video can still rank.</p>
            <button className="btn sm" onClick={() => set({pick: s.seed})} disabled={!s.seed}>Score “{s.seed}”</button></section>}
      </aside>
    </div>
  </div>;
}

function Video({v, onPick}) {
  return <div className="rs-vid">
    <a href={'https://www.youtube.com/watch?v=' + v.id} target="_blank" rel="noreferrer"><img src={thumb(v.id)} alt="" loading="lazy" referrerPolicy="no-referrer"/></a>
    <div>
      <a className="rs-vt" href={'https://www.youtube.com/watch?v=' + v.id} target="_blank" rel="noreferrer" title={v.title}>{v.title}</a>
      <span className="muted small">{v.name ?? v.channel}{v.views != null ? ' · ' + fmt(v.views) + ' views' : ''}{v.age ? ' · ' + v.age : ''}</span>
      <span className="rs-vmeta">{v.score != null && <span className={'small ' + (v.score >= 2 ? 'up-text' : 'muted')}>{v.score.toFixed(1)}× usual</span>}
        {onPick && <button className="gt-link small" onClick={onPick}>Score this title</button>}</span>
    </div>
  </div>;
}

function Spark({series}) {
  if (series.length < 2) return null;
  const W = 300, H = 60, n = series.length, x = i => i * W / (n - 1), y = v => H - 4 - v * (H - 8) / 100;
  return <svg className="rs-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Interest over 12 months">
    <path d={series.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ') + ` L${W} ${H} L0 ${H} Z`} fill="color-mix(in srgb, var(--accent) 18%, transparent)"/>
    <path d={series.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ')} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke"/>
  </svg>;
}

function Scorecard({q, geo, onPick, saved, onSave, onUnsave, inCompare, onCompare}) {
  const [showAngles, setShowAngles] = useState(false);
  const [d, setD] = useState(null), [err, setErr] = useState(null);
  useEffect(() => {
    let live = true; setD(null); setErr(null);
    get('score', {q, geo}).then(x => live && setD(x), e => live && setErr(e.message));
    return () => { live = false; };
  }, [q, geo]);
  if (err) return <section className="card"><h2 className="rs-title">{q}</h2><p className="down-text">{err}</p></section>;
  if (!d) return <section className="card"><h2 className="rs-title">{q}</h2><p className="muted small">Reading YouTube search and Google Trends…</p>
    {Array.from({length: 6}, (_, i) => <div key={i} className="sk" style={{height: i ? 26 : 70, borderRadius: 8, margin: '10px 0'}}/>)}</section>;
  return <>
    <section className="card">
      <h2 className="rs-title">{d.q}</h2>
      <div className="rs-total">
        <div className="rs-ring" style={{'--v': d.total, '--c': tone(d.total)}}><b>{d.total}</b></div>
        <div><b style={{color: tone(d.total)}}>{d.verdict}</b><span className="muted small">Topic score out of 100 · {d.via === 'vercel' ? 'via the website' : 'via a node'}</span>
          <a className="small" href={'https://www.youtube.com/results?search_query=' + encodeURIComponent(d.q)} target="_blank" rel="noreferrer">Open on YouTube ↗</a></div>
      </div>
      <div className="rs-actions">
        {saved ? <button className="btn sm on" onClick={onUnsave} title="Remove from saved ideas">★ Saved</button> : <button className="btn sm" onClick={() => onSave(d)}>☆ Save idea</button>}
        <button className={'btn sm' + (inCompare ? ' on' : '')} onClick={onCompare}>{inCompare ? '✓ In compare' : '+ Compare'}</button>
        <button className="btn sm" onClick={() => setShowAngles(true)} disabled={showAngles}>Angles & titles</button>
      </div>
      <div className="rs-parts">{d.parts.map(p => <div key={p.key} className="rs-part">
        <div className="rs-pl"><span>{p.label}</span><b style={{color: tone(p.value)}}>{p.value}</b></div>
        <span className="gt-bar"><i style={{width: p.value + '%', background: tone(p.value)}}/></span>
        <span className="muted small">{p.note}</span>
      </div>)}</div>
      {d.series.length > 0 && <><div className="rs-sub">YouTube search interest, 12 months</div><Spark series={d.series}/></>}
      {d.trendsError && <p className="muted small">Google Trends: {d.trendsError}</p>}
    </section>
    {d.related.rising.length > 0 && <section className="card">
      <div className="gt-head"><h2>Rising around it</h2></div>
      <div className="rs-chips">{d.related.rising.slice(0, 10).map(r => <button key={r.query} className="gt-cat" onClick={() => onPick(r.query)}>{r.query} <span className="up-text">{r.value}</span></button>)}</div>
    </section>}
    <section className="card">
      <div className="gt-head"><h2>What ranks now</h2><span className="muted small">top {d.results.length} on YouTube</span></div>
      <div className="rs-vids">{d.results.slice(0, 10).map(v => <Video key={v.id} v={v}/>)}</div>
    </section>
    <Brief q={d.q} saved={saved} onSaveBrief={b => onSave(d, b)}/>
    {showAngles && <Angles q={d.q} geo={geo} onPick={onPick}/>}
    {d.coverage && <section className="card">
      <div className="gt-head"><h2>Already covered</h2><span className="muted small">your channels and competitors</span></div>
      {d.coverage.length ? <div className="rs-vids">{d.coverage.slice(0, 8).map(v => <Video key={v.id} v={{...v, name: v.name + (v.kind === 'own' ? ' (yours)' : '')}}/>)}</div>
        : <p className="muted">Nobody you track has a video on this yet.</p>}
    </section>}
  </>;
}

// ---------- angles & titles (step 4) ----------
function Angles({q, geo, onPick}) {
  const [d, setD] = useState(null), [err, setErr] = useState(null);
  useEffect(() => { let live = true; get('angles', {q, geo}).then(x => live && setD(x), e => live && setErr(e.message)); return () => { live = false; }; }, [q, geo]);
  if (err) return <section className="card"><h2 className="rs-h">Angles & titles</h2><p className="down-text">{err}</p></section>;
  if (!d) return <section className="card"><h2 className="rs-h">Angles & titles</h2>{Array.from({length: 4}, (_, i) => <div key={i} className="sk" style={{height: 40, borderRadius: 8, margin: '8px 0'}}/>)}</section>;
  return <>
    <section className="card">
      <div className="gt-head"><h2>Title patterns that work</h2><span className="muted small">from {d.sample} top and competitor videos</span></div>
      <div className="rs-pats">{d.patterns.map(p => <details key={p.key} className="rs-pat">
        <summary><span>{p.label}</span><span className="muted small">{p.count} videos · {p.share}%</span>
          {p.lift != null && <b className={p.lift >= 1.2 ? 'up-text' : p.lift < .8 ? 'down-text' : 'muted'}>{p.lift.toFixed(1)}× views</b>}</summary>
        {p.examples.map(e => <a key={e.id} href={'https://www.youtube.com/watch?v=' + e.id} target="_blank" rel="noreferrer">{e.title} <span className="muted">· {fmt(e.views ?? 0)} views</span></a>)}
      </details>)}</div>
      <p className="muted small">“× views” compares the median views of titles using that pattern with all of them. Click a pattern for examples.</p>
      <div className="rs-style">
        <span><b>{d.style.length ?? '—'}</b> characters typical</span><span><b>{d.style.numbers}%</b> use numbers</span>
        <span><b>{d.style.emoji}%</b> use emoji</span><span><b>{d.style.caps}%</b> use CAPS words</span>
      </div>
    </section>
    {d.questions.length > 0 && <section className="card">
      <div className="gt-head"><h2>Sub-angles & questions</h2><span className="muted small">good for Shorts or chapters</span></div>
      <div className="rs-chips">{d.questions.map(x => <button key={x} className="gt-cat" onClick={() => onPick(x)}>{x}</button>)}</div>
    </section>}
    <section className="card">
      <div className="gt-head"><h2>Thumbnails that rank</h2></div>
      <div className="rs-thumbs">{d.thumbs.map(v => <a key={v.id} href={'https://www.youtube.com/watch?v=' + v.id} target="_blank" rel="noreferrer" title={v.title}>
        <img src={`https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`} alt="" loading="lazy" referrerPolicy="no-referrer"/><span className="muted small">{fmt(v.views ?? 0)} views</span></a>)}</div>
    </section>
  </>;
}

// ---------- saved ideas (step 2) ----------
const STATUSES = ['Idea', 'Researching', 'Approved', 'Dropped'];
function Saved({list, err, own, onOpen, onSave, onRemove, onOpenPlanner, onCompare, cmp}) {
  const [show, setShow] = useState('active'), [plan, setPlan] = useState(null), [open, setOpen] = useState(null);
  if (err) return <section className="card"><p className="down-text">Saved ideas need one of your computers (a node): {err}</p></section>;
  if (!list) return <section className="card">{Array.from({length: 5}, (_, i) => <div key={i} className="sk" style={{height: 44, borderRadius: 8, margin: '8px 0'}}/>)}</section>;
  const rows = list.filter(x => show === 'all' || (show === 'active' ? x.status !== 'Dropped' : x.status === show));
  return <>
    <div className="toolbar"><div className="seg sm" role="group" aria-label="Show">
      {[['active', 'Active'], ...STATUSES.map(x => [x, x]), ['all', 'All']].map(([k, l]) => <button key={k} aria-pressed={show === k} onClick={() => setShow(k)}>{l} <span className="muted">{k === 'all' ? list.length : k === 'active' ? list.filter(x => x.status !== 'Dropped').length : list.filter(x => x.status === k).length}</span></button>)}
    </div><span className="muted small">Saved topics are re-scored every week, so you can see them heat up or cool down.</span></div>
    {!rows.length ? <section className="card"><div className="gt-empty">{list.length ? 'Nothing here.' : 'No saved ideas yet. Open an idea’s scorecard and press “☆ Save idea”.'}</div></section>
      : <section className="card rs-saved">{rows.map(x => {
        const prev = x.history?.length > 1 ? x.history.at(-2).total : null, change = prev != null ? x.total - prev : null;
        return <div key={x.q + x.geo} className="rs-srow">
          <div className="rs-sscore" style={{'--c': tone(x.total ?? 0)}}><b>{x.total ?? '—'}</b>{change ? <span className={change > 0 ? 'up-text' : 'down-text'}>{change > 0 ? '▲' : '▼'}{Math.abs(change)}</span> : null}</div>
          <div className="rs-smain">
            <button className="gt-link rs-sq" onClick={() => onOpen(x)}>{x.q}</button>
            <span className="muted small">{x.verdict} · {x.geo || 'Worldwide'} · saved {new Date(x.savedAt).toLocaleDateString('en-IN', {day: 'numeric', month: 'short'})}{x.plan ? ' · in Planner' : ''}</span>
            {(x.brief || x.pick) && <span className="rs-sai">
              {x.pick && <button className={'btn sm' + (open === x.q + '|pick' ? ' on' : '')} onClick={() => setOpen(open === x.q + '|pick' ? null : x.q + '|pick')}>✦ AI pick</button>}
              {x.brief && <button className={'btn sm' + (open === x.q + '|brief' ? ' on' : '')} onClick={() => setOpen(open === x.q + '|brief' ? null : x.q + '|brief')}>✦ AI brief</button>}
            </span>}
            <input className="rs-notes" defaultValue={x.notes} placeholder="Notes: angle, references, why it’s good…" aria-label={'Notes for ' + x.q}
              onBlur={e => e.target.value !== (x.notes ?? '') && onSave({q: x.q, geo: x.geo, notes: e.target.value})}/>
          </div>
          <div className="rs-sact">
            <select aria-label="Status" value={x.status} onChange={e => onSave({q: x.q, geo: x.geo, status: e.target.value})}>{STATUSES.map(v => <option key={v}>{v}</option>)}</select>
            <button className={'btn sm' + (cmp.includes(x.q) ? ' on' : '')} onClick={() => onCompare(x.q)}>{cmp.includes(x.q) ? '✓ Compare' : '+ Compare'}</button>
            <button className="btn sm primary" onClick={() => setPlan(x)}>{x.plan ? 'Plan again' : 'Send to Planner'}</button>
            <button className="btn sm" aria-label={'Remove ' + x.q} onClick={() => onRemove(x)}>Remove</button>
          </div>
          {open === x.q + '|pick' && x.pick && <div className="rs-sopen"><PickView p={x.pick}/></div>}
          {open === x.q + '|brief' && x.brief && <div className="rs-sopen rs-brief"><div className="rs-b"><BriefView b={x.brief}/>
            <div className="rs-bfoot muted small">{x.brief.model} · {new Date(x.brief.fetched).toLocaleString('en-IN', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'})}</div></div></div>}
        </div>;
      })}</section>}
    {plan && <PlanDialog x={plan} own={own} onClose={() => setPlan(null)} onDone={id => { onSave({q: plan.q, geo: plan.geo, status: 'Approved', plan: id}); setPlan(null); toast('Added to the Planner'); onOpenPlanner?.(); }}/>}
  </>;
}

function PlanDialog({x, own, onClose, onDone}) {
  const [title, setTitle] = useState(x.q.replace(/\b\w/g, c => c.toUpperCase())), [channel, setChannel] = useState(own[0]?.id ?? ''), [format, setFormat] = useState('Long-form'), [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    const id = 'rs-' + Math.random().toString(36).slice(2, 12);
    const ai = [x.pick && `AI pick: ${x.pick.why}${x.pick.newBecause ? ' New because: ' + x.pick.newBecause : ''}`,
      x.brief?.best_angle && 'Best angle: ' + x.brief.best_angle, x.brief?.titles?.length && 'Titles: ' + x.brief.titles.map(t => t.title).join(' | '),
      x.brief?.hook && 'Hook: ' + x.brief.hook, x.brief?.outline?.length && 'Outline: ' + x.brief.outline.join(' → ')].filter(Boolean).join(String.fromCharCode(10));
    const notes = (ai ? ai + String.fromCharCode(10) : '') + `From Topic research: score ${x.total ?? '—'} (${x.verdict ?? 'not scored'}) for “${x.q}”${x.geo ? ' in ' + x.geo : ''}.` + (x.notes ? '\n' + x.notes : '') +
      '\nYouTube search: https://www.youtube.com/results?search_query=' + encodeURIComponent(x.q);
    try { await api('/api/plans', {method: 'POST', body: JSON.stringify({id, title, channel, format, status: 'Idea', notes})}); onDone(id); }
    catch (e) { toast(e.message); setBusy(false); }
  };
  return createPortal(<div className="rs-modal" role="dialog" aria-modal="true" aria-label="Send to Planner" onClick={e => e.target === e.currentTarget && onClose()}>
    <div className="card rs-dialog">
      <h2 className="rs-h">Send to Planner</h2>
      <label>Working title<input value={title} onChange={e => setTitle(e.target.value)} autoFocus/></label>
      <label>Channel<select value={channel} onChange={e => setChannel(e.target.value)}>{own.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Format<select value={format} onChange={e => setFormat(e.target.value)}><option>Long-form</option><option>Short</option></select></label>
      <p className="muted small">The score, your notes and a YouTube search link go into the plan’s notes. The idea is marked Approved.</p>
      <div className="row" style={{justifyContent: 'flex-end'}}><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !title.trim()} onClick={send}>{busy ? 'Adding…' : 'Add to Planner'}</button></div>
    </div>
  </div>, document.body);
}

// ---------- compare (step 3) ----------
const CC = ['#4c8dff', '#ff6b6b', '#ffb340', '#3ccf8e', '#b57bff'];
function Compare({topics, geo, onRemove, onOpen}) {
  const [d, setD] = useState(null), [err, setErr] = useState(null);
  const key = topics.join('|') + geo;
  useEffect(() => {
    if (topics.length < 2) return;
    let live = true; setD(null); setErr(null);
    get('compare', {q: topics.join(','), geo}).then(x => live && setD(x), e => live && setErr(e.message));
    return () => { live = false; };
  }, [key]);
  if (topics.length < 2) return <section className="card"><div className="gt-empty">Add at least 2 topics with “+ Compare” on a scorecard or a saved idea (up to 5).
    {topics.length === 1 && <div style={{marginTop: 10}}><span className="gt-cat">{topics[0]} <span role="button" onClick={() => onRemove(topics[0])}>×</span></span></div>}</div></section>;
  const chips = <div className="rs-chips" style={{marginTop: 12}}>{topics.map((t, i) => <span key={t} className="gt-cat rs-cchip"><i style={{background: CC[i]}}/>{t}<button aria-label={'Remove ' + t} onClick={() => onRemove(t)}>×</button></span>)}</div>;
  if (err) return <>{chips}<section className="card"><p className="down-text">{err}</p></section></>;
  if (!d) return <>{chips}<section className="card"><p className="muted small">Scoring {topics.length} topics and reading Google Trends… this can take a little while.</p><div className="sk" style={{height: 220, borderRadius: 10}}/></section></>;
  const pts = d.trends?.points ?? [], W = 900, H = 220, P = 30, n = pts.length, x = i => P + i * (W - 2 * P) / Math.max(1, n - 1), y = v => H - P - v * (H - 2 * P) / 100;
  const ok = d.cards.filter(c => !c.error), best = Math.max(...ok.map(c => c.total));
  const PARTS = ok[0]?.parts.map(p => [p.key, p.label]) ?? [];
  return <>
    {chips}
    <section className="card">
      <div className="gt-head"><h2>Search interest on YouTube, 12 months</h2><span className="muted small">shared scale: 100 = busiest week of any topic</span></div>
      {n > 1 ? <TrendChart d={{...d.trends, keywords: topics}}/> : <p className="muted">{d.trendsError ?? 'Not enough Google Trends data.'}</p>}
      {d.trends && <div className="rs-avgs">{topics.map((t, k) => <span key={t}><i style={{background: CC[k]}}/>{t}<span className="muted small">avg</span><b>{Math.round(d.trends.averages[k] ?? 0)}</b></span>)}</div>}
    </section>
    <section className="card rs-ctable">
      <table className="cs-table"><thead><tr><th>Topic</th><th>Score</th>{PARTS.map(([k, l]) => <th key={k}>{l}</th>)}<th></th></tr></thead>
        <tbody>{d.cards.map((c, i) => <tr key={c.q}>
          <td><span className="rs-dot" style={{background: CC[i]}}/>{c.q}</td>
          {c.error ? <td colSpan={PARTS.length + 2} className="down-text">{c.error}</td> : <>
            <td><b style={{color: tone(c.total)}}>{c.total}</b>{c.total === best && ok.length > 1 && <span className="pill">Best</span>}<div className="muted small">{c.verdict}</div></td>
            {PARTS.map(([k]) => { const p = c.parts.find(x => x.key === k); return <td key={k} title={p?.note}><span style={{color: tone(p?.value ?? 0)}}>{p?.value ?? '—'}</span></td>; })}
            <td><button className="btn sm" onClick={() => onOpen(c.q)}>Open</button></td></>}
        </tr>)}</tbody></table>
    </section>
    <section className="card">
      <div className="gt-head"><h2>Top thumbnails per topic</h2></div>
      <div className="rs-cthumbs">{d.cards.filter(c => !c.error).map((c, i) => <div key={c.q}><span className="small"><span className="rs-dot" style={{background: CC[topics.indexOf(c.q)]}}/>{c.q}</span>
        <div className="rs-thumbs">{c.top.map(v => <a key={v.id} href={'https://www.youtube.com/watch?v=' + v.id} target="_blank" rel="noreferrer" title={v.title}><img src={`https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`} alt="" loading="lazy" referrerPolicy="no-referrer"/><span className="muted small">{fmt(v.views ?? 0)}</span></a>)}</div></div>)}</div>
    </section>
  </>;
}

// ---------- AI brief (Gemini; nodes only) ----------
const LANGS = [['english', 'English'], ['hinglish', 'Hinglish'], ['hindi', 'Hindi']];
const copy = t => navigator.clipboard?.writeText(t).then(() => toast('Copied'), () => {});
function Brief({q, saved, onSaveBrief}) {
  const [lang, setLang] = usePref('researchLang', 'hinglish');
  const [state, setState] = useState({}), [secs, setSecs] = useState(0);
  // a brief kept with the saved idea shows straight away (no new Gemini call)
  const b = state.q === q && state.lang === lang && state.data ? state.data : !(state.busy && state.q === q) && saved?.brief?.q === q ? saved.brief : null, busy = state.busy && state.q === q;
  const kept = !!b && saved?.brief?.fetched === b.fetched;
  useEffect(() => { if (!busy) return; const t0 = Date.now(), t = setInterval(() => setSecs(Math.round((Date.now() - t0) / 1000)), 1000); return () => clearInterval(t); }, [busy]);
  const run = fresh => {
    setState({q, lang, busy: true}); setSecs(0);
    api('/api/research/brief', {method: 'POST', body: JSON.stringify({q, lang, fresh})})
      .then(data => { setState({q, lang, data}); if (saved) onSaveBrief?.(data); }, e => setState({q, lang, error: e.message}));   // idea already saved: keep the new brief with it
  };
  const err = state.q === q && state.lang === lang ? state.error : null;
  return <section className="card rs-brief">
    <div className="gt-head"><h2>✦ AI brief</h2><span className="muted small">Gemini, from this research</span>
      <div className="seg sm" role="group" aria-label="Language for titles">{LANGS.map(([k, l]) => <button key={k} aria-pressed={lang === k} onClick={() => setLang(k)}>{l}</button>)}</div>
    </div>
    {busy ? <p className="muted"><span className="spinner sm"/> Writing the brief… {secs}s <span className="small">(usually under a minute)</span></p>
      : !b ? <>
        {err && <p className="down-text small">{err}</p>}
        <p className="muted small">Titles, the best angle, what current videos miss, a hook, an outline, Shorts and thumbnail text, based on the score, top videos and searches above.</p>
        <button className="btn primary sm" onClick={() => run(false)}>Write AI brief</button>
      </> : <div className="rs-b">
        <BriefView b={b}/>
        <div className="rs-bfoot muted small">{b.model} · {new Date(b.fetched).toLocaleString('en-IN', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'})} · AI can be wrong; check facts before using
          {kept ? <span>★ Saved with the idea</span> : <button className="btn sm" onClick={() => onSaveBrief?.(b)}>{saved ? '☆ Keep this brief' : '☆ Save idea with brief'}</button>}
          <button className="btn sm" onClick={() => run(true)}>Write again</button></div>
      </div>}
  </section>;
}
function BriefView({b}) {
  return <>
        <p>{b.summary}</p>
        {b.best_angle && <div className="rs-bbox"><span className="rs-sub">Best angle</span>{b.best_angle}</div>}
        {b.gap && <div className="rs-bbox"><span className="rs-sub">What current videos miss</span>{b.gap}</div>}
        {b.titles?.length > 0 && <><div className="rs-sub">Titles</div><ol className="rs-btitles">{b.titles.map((t, i) => <li key={i}>
          <div><b>{t.title}</b><span className="muted small">{t.why}</span></div><button className="btn sm" onClick={() => copy(t.title)} aria-label="Copy title">Copy</button></li>)}</ol></>}
        {b.angles?.length > 0 && <><div className="rs-sub">Other angles</div><ul className="rs-bl">{b.angles.map((a, i) => <li key={i}><b>{a.angle}</b> <span className="muted">— {a.why}</span></li>)}</ul></>}
        {b.hook && <><div className="rs-sub">Hook (first 15 seconds)</div><blockquote className="rs-hook">{b.hook}<button className="btn sm" onClick={() => copy(b.hook)}>Copy</button></blockquote></>}
        {b.outline?.length > 0 && <><div className="rs-sub">Outline</div><ol className="rs-bl">{b.outline.map((x, i) => <li key={i}>{x}</li>)}</ol></>}
        {b.shorts?.length > 0 && <><div className="rs-sub">Shorts ideas</div><ul className="rs-bl">{b.shorts.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
        {b.thumbnail_text?.length > 0 && <><div className="rs-sub">Thumbnail text</div><div className="rs-chips">{b.thumbnail_text.map(x => <button key={x} className="gt-cat rs-tt" onClick={() => copy(x)} title="Copy">{x}</button>)}</div></>}
        {b.risks?.length > 0 && <><div className="rs-sub">Risks</div><ul className="rs-bl muted">{b.risks.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
  </>;
}
function PickView({p}) {
  return <div className="rs-b">
    {p.title && <h3 style={{margin: 0}}>{p.title}</h3>}
    <p>{p.why}</p>
    {p.newBecause && <p className="small"><b>New because:</b> {p.newBecause}</p>}
    {p.evidence?.length > 0 && <ul className="rs-ev">{p.evidence.map((e, j) => <li key={j}>{e.video ? <a href={'https://www.youtube.com/watch?v=' + e.video} target="_blank" rel="noreferrer">{e.text}</a> : e.text}</li>)}</ul>}
    <span className="muted small">{[p.kind && KIND_LABEL[p.kind], p.format, p.urgency].filter(Boolean).join(' · ')}</span>
  </div>;
}

// ---------- AI picks: topics suggested automatically, with reasons ----------
const URGENCY = {now: ['Make now', 'down-text'], 'this week': ['This week', 'warn'], evergreen: ['Evergreen', 'muted']};
const VOTES = [['up', '👍', 'More like this'], ['down', '👎', 'Not for us'], ['made', '✓ Made', 'We made this']];
const FOCUS = [['', 'Mix', 'A few of each kind'], ['fresh', '✦ New ideas', 'Concepts we have never covered, like “AI laptop vs normal laptop”'],
  ['gap', 'Ranking gaps', 'Budgets where our search rankings are weak, missing or slipping'], ['news', 'News', 'Launches, sales and news happening now'],
  ['trend', 'Trends', 'Searches climbing on Google Trends, or a seasonal peak coming up']];
const KIND_LABEL = {fresh: '✦ New idea', gap: 'Ranking gap', news: 'News', trend: 'Trend'};
function Picks({onScore, onExplore, isSaved, onSave, channels = []}) {
  const [channel, setChannel] = usePref('researchPicksFor', 'all');
  const [focus, setFocus] = usePref('researchPicksFocus', '');
  const [d, setD] = useState(null), [err, setErr] = useState(null), [busy, setBusy] = useState(false), [secs, setSecs] = useState(0);
  const [showProfile, setShowProfile] = useState(false);
  const load = () => api('/api/research/picks?channel=' + channel + (focus ? '&focus=' + focus : '')).then(x => { setD(x); return x; });
  const make = () => {
    setBusy(true); setErr(null); setSecs(0);
    const t0 = Date.now(), t = setInterval(() => setSecs(Math.round((Date.now() - t0) / 1000)), 1000);
    api('/api/research/picks', {method: 'POST', body: JSON.stringify({channel, focus})}).then(setD, e => setErr(e.message)).finally(() => { clearInterval(t); setBusy(false); });
  };
  useEffect(() => {   // stored picks at once; new ones automatically when they're over a day old
    setD(null); setErr(null);
    load().then(x => { if (x.stale) make(); }, e => setErr(e.message));
  }, [channel, focus]);
  useEffect(() => {   // while picks are being scored in the background, check every few seconds
    if (!d?.scoring) return;
    const t = setInterval(() => load().catch(() => {}), 6000);
    return () => clearInterval(t);
  }, [d?.scoring, channel, focus]);
  const vote = (p, v) => {
    const next = p.vote === v ? 'none' : v;
    setD(x => ({...x, picks: x.picks.map(q => q.topic === p.topic ? {...q, vote: next === 'none' ? null : next} : q)}));
    api('/api/research/picks/vote', {method: 'POST', body: JSON.stringify({topic: p.topic, vote: next, channel, focus})}).catch(e => toast(e.message));
  };
  const own = d?.own ?? [];
  const u = d?.used;
  return <>
    <div className="rk-chans rs-chans" role="tablist" aria-label="Picks for">
      <button role="tab" className="rk-chan" aria-pressed={channel === 'all'} onClick={() => setChannel('all')} disabled={busy}>
        <span className="rs-allav">✦</span><span><b>All channels</b><small>Whole network</small></span></button>
      {own.map(c => { const full = channels.find(o => o.id === c.id) ?? c;
        return <button key={c.id} role="tab" className="rk-chan" aria-pressed={channel === String(c.id)} onClick={() => setChannel(String(c.id))} disabled={busy}>
          <Avatar channel={full} size={36}/><span><b>{c.name}</b><small>Picks for this channel</small></span></button>; })}
    </div>
    <div className="toolbar spread rk-cats rs-phead">
      <div className="seg sm" role="group" aria-label="Kind of ideas">
        {FOCUS.map(([k, l, t]) => <button key={k} title={t} aria-pressed={focus === k} onClick={() => setFocus(k)} disabled={busy}>{l}</button>)}
      </div>
      <div className="row">
        <button className={'btn sm' + (showProfile ? ' on' : '')} onClick={() => setShowProfile(!showProfile)}>Channel profile{u && !u.profile ? ' ·  add one' : ''}</button>
        <button className="btn sm primary" onClick={make} disabled={busy}>{busy ? <><span className="spinner sm"/> Thinking… {secs}s</> : 'Suggest again'}</button>
      </div>
    </div>
    {showProfile && <Profile onSaved={() => { setShowProfile(false); toast('Profile saved. Press “Suggest again” to use it.'); }}/>}
    {d?.at && <p className="muted small rs-used">Suggested {new Date(d.at).toLocaleString('en-IN', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'})} by {d.model} after weighing {d.candidates ?? '—'} candidates. Used: {u?.profile ? 'your profile, ' : ''}{u?.ranks ? u.ranks + ' of our tracked rankings, ' : ''}{u?.nicheTrends ? u.nicheTrends + ' niche Google Trends, ' : ''}{u?.ranked ? u.ranked + ' live YouTube rankings, ' : ''}{u?.rivals} competitor hits, {u?.myHits} of your best videos, {u?.trends} India trends, {u?.plans} Planner entries, {u?.saved} saved ideas, {u?.votes} of your votes. Refreshes daily.
      {d.scoring && <> · <span className="spinner sm"/> checking each pick against YouTube and Trends…</>}</p>}
    {err && <section className="card"><p className="down-text">{err}</p></section>}
    {!d?.picks?.length ? (busy || !d) && <div className="rs-picks">{Array.from({length: 4}, (_, i) => <section key={i} className="card"><div className="sk" style={{height: 150, borderRadius: 10}}/></section>)}</div>
      : <div className="rs-picks">{d.picks.map((p, i) => {
        const [ul, uc] = URGENCY[p.urgency] ?? URGENCY.evergreen, sc = p.score;
        return <section key={p.topic + i} className={'card rs-pick' + (p.vote === 'down' ? ' voted-down' : '')}>
          <div className="rs-ptop">
            <span className={'rs-urg ' + uc}>{ul}</span>{p.kind && <span className="rs-tag">{KIND_LABEL[p.kind]}</span>}<span className="rs-tag">{p.format}</span><span className={'rs-tag conf-' + p.confidence}>{p.confidence} confidence</span>
            <span className="rs-pscore" title={sc?.parts?.map(x => x.label + ' ' + x.value).join(' · ') ?? ''}>{sc == null ? <span className="muted small"><span className="spinner sm"/> scoring</span>
              : sc.error ? <span className="muted small">no score</span>
              : <><b style={{color: tone(sc.total)}}>{sc.total}</b><span className="muted small">{sc.total < 40 ? 'weak on numbers' : sc.verdict}</span></>}</span>
          </div>
          <h3>{p.title || p.topic}</h3>
          <span className="muted small">Search: {p.topic}</span>
          <p>{p.why}</p>
          {p.newBecause && <p className="small"><b>New because:</b> {p.newBecause}</p>}
          {p.evidence.length > 0 && <ul className="rs-ev">{p.evidence.map((e, j) => <li key={j}>{e.video ? <a href={'https://www.youtube.com/watch?v=' + e.video} target="_blank" rel="noreferrer">{e.text}</a> : e.text}</li>)}</ul>}
          <div className="rs-pact">
            <button className="btn sm primary" onClick={() => onScore(p)}>Open scorecard</button>
            <button className="btn sm" onClick={() => onExplore(p)}>Related ideas</button>
            {isSaved(p) ? <span className="muted small">★ Saved</span> : <button className="btn sm" onClick={() => onSave(p)}>☆ Save</button>}
            <span className="rs-votes">{VOTES.map(([v, l, t]) => <button key={v} className={'btn sm' + (p.vote === v ? ' on' : '')} title={t} aria-pressed={p.vote === v} onClick={() => vote(p, v)}>{l}</button>)}</span>
          </div>
        </section>;
      })}</div>}
  </>;
}

function Profile({onSaved}) {
  const [p, setP] = useState(null), [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/research/profile').then(setP, e => toast(e.message)); }, []);
  if (!p) return <section className="card"><div className="sk" style={{height: 120, borderRadius: 10}}/></section>;
  const save = () => { setBusy(true); api('/api/research/profile', {method: 'POST', body: JSON.stringify(p)}).then(onSaved, e => toast(e.message)).finally(() => setBusy(false)); };
  return <section className="card rs-profile">
    <div className="gt-head"><h2>Channel profile</h2><span className="muted small">Gemini reads this before suggesting anything. The more specific, the better the picks.</span></div>
    <label>About all our channels<textarea rows={3} value={p.general} onChange={e => setP({...p, general: e.target.value})}
      placeholder="e.g. Indian tech network. Audience: students and first-time buyers in tier 2–3 cities. We get review units from Asus, HP, Lenovo. We don't do Apple repairs or PC builds above ₹1.5L."/></label>
    {p.own.map(c => <label key={c.id}>{c.name}<textarea rows={2} value={p.channels?.[c.id] ?? ''} onChange={e => setP({...p, channels: {...p.channels, [c.id]: e.target.value}})}
      placeholder="Language, niche, price bands, formats that work, what to avoid…"/></label>)}
    <div className="row" style={{justifyContent: 'flex-end'}}><button className="btn primary sm" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button></div>
  </section>;
}
