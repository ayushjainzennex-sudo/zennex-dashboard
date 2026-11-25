import React, {useState, useEffect, useMemo} from 'react';
import {AlertList, DAY, Kpi, ScoreChip, fmt, median, short} from '../shared.jsx';

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

export {Report};
