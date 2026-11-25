import React, {useState, useEffect, useMemo} from 'react';
import {ChannelSelect, DAY, median, short, words} from '../shared.jsx';

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

export {Insights};
