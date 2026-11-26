import React, {useState, useEffect, useMemo} from 'react';
import {onChange} from '../remote.js';
import {Avatar, DAY, Delta, Kpi, LaunchTracker, OutlierBadge, OutlierCard, PageSkeleton, ago, api, avatarAt, duration, fmt, projection, short, shortDate, stats, thumbProps, toast, usePref} from '../shared.jsx';

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

// Stats for a channel opened from search that you don't track. Served from a cache (refreshed after 4 hours).
function LookupPage({channelId, own, onTrack, onTracked}) {
  const [d, setD] = useState(null), [err, setErr] = useState(''), [adding, setAdding] = useState(null);
  const load = () => { setErr(''); api('/api/lookup/'+channelId).then(x => x.tracked ? onTracked(x.tracked) : setD(x)).catch(e => setErr(e.message)); };
  useEffect(load, [channelId]);
  if (err) return <div className="card"><p className="error" role="alert">{err}</p><button className="btn" onClick={load}>Retry</button></div>;
  if (!d) return <PageSkeleton page="ch:"/>;
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

    <OutlierCard windowed channels={[c]} title="Outliers on this channel" note={`Compared with this channel's last ${c.poolSize} stored videos, by format. The baseline widens as the database collects more uploads.`}/>
    <section className="card">
      <div className="card-head"><h2>Recent uploads</h2>
        <div className="seg" role="group" aria-label="Sort videos">{[['new','Newest'],['views','Most viewed'],['trend','Trending'],['outlier','Outlier score']].map(([k,l]) => <button key={k} aria-pressed={sort===k} onClick={() => setSort(k)}>{l}</button>)}</div>
      </div>
      <div className="video-grid">{videos.map(v => <VideoCard v={v} key={v.id}/>)}</div>
      {!videos.length && <p className="muted">No uploads loaded yet.</p>}
    </section>
  </>;
}

// ---------- date range ----------
const RANGES = [[7,'7D'],[30,'30D'],[90,'90D'],[0,'All']];

function RangeSeg({value, onChange}) {
  return <div className="seg sm" role="group" aria-label="Date range">{RANGES.map(([d, l]) => <button key={d} aria-pressed={value === d} onClick={() => onChange(d)}>{l}</button>)}</div>;
}

const inRange = (history, days) => days ? history.filter(h => new Date(h.date) >= Date.now() - days * DAY) : history;

export {ChannelPage, LookupPage};
