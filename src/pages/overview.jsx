import React, {useState, useEffect, useMemo} from 'react';
import {ChannelCard, ComparisonTable, DAY, Delta, Kpi, LaunchTracker, OutlierCard, VideoList, fmt, short, stats} from '../shared.jsx';

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

export {Overview};
