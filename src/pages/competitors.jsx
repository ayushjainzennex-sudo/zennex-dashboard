import React, {useState, useEffect, useMemo} from 'react';
import {Avatar, ChannelCard, ChannelSelect, ComparisonTable, OutlierCard, ScoreChip, ago, fmt, median, short, stats, thumbProps, words} from '../shared.jsx';

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

export {Competitors};
