import React, {useState, useEffect, useMemo} from 'react';
import {ago, avg, fmt, fresh, short, shortDate, toast, usePref, yt} from '../shared.jsx';

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

export {Rankings};
