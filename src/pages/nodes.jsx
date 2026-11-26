import React, {useState, useEffect, useMemo} from 'react';
import {REMOTE, state as remoteState} from '../remote.js';
import {Kpi, PageSkeleton, ago, agoS, api, ask, fmt, mb, toast} from '../shared.jsx';

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

function NodeCard({n, self, serving, busy, onMode, onRemove, onUpdate, latency}) {
  const st = n.stats ?? {}, u = st.update, memUsed = st.mem ? 1 - st.mem.free / st.mem.total : null, diskFree = st.disk?.free;
  const work = st.work ?? {}, workTotal = Object.values(work).reduce((a, b) => a + b, 0);
  const limited = st.rateLimitedUntil && new Date(st.rateLimitedUntil) > Date.now();
  const offline = n.health === 'offline';
  const pct = v => v == null ? null : Math.max(0, Math.min(100, v));
  const host = u => u.replace(/^https?:\/\//, '');
  const Meter = ({v, warn = 85}) => v == null ? null : <span className={'nmeter'+(v >= warn ? ' hot' : '')}><i style={{width:v+'%'}}/></span>;
  return <article className={'node '+n.health+(n.mode !== 'active' ? ' mode-'+n.mode : '')}>
    <header className="node-head">
      <span className="node-dot" aria-hidden="true"/>
      <div className="node-title">
        <strong title={n.name}>{n.name}</strong>
        <span className="muted small">{HEALTH[n.health]} · {offline ? 'last seen '+ago(n.last_seen) : 'heartbeat '+agoS(n.last_seen)}</span>
      </div>
      <div className="node-ping" title="Response time from this browser">{offline ? <span className="muted">—</span> : latency === undefined ? <span className="spinner"/> : latency == null ? <span className="down small">unreachable</span> : <><b>{latency}</b><span className="muted small"> ms</span></>}</div>
    </header>
    <div className="node-pills">
      {REMOTE ? serving && <span className="pill">Serving this page</span> : self && <span className="pill">This node</span>}
      {st.tunnel && <span className={'pill '+(st.tunnel.state === 'up' ? 'ok' : 'warn')} title={st.tunnel.error ?? 'Reachable from the internet through a Cloudflare tunnel'}>{st.tunnel.state === 'up' ? 'Online' : 'Tunnel '+st.tunnel.state}</span>}
      {n.mode !== 'active' && <span className={'pill '+n.mode}>{n.mode === 'draining' ? 'Draining' : 'Disabled'}</span>}
      {n.outdated && <span className="pill warn" title="Its server code differs from the newest node. Update it so all nodes behave the same.">Different version</span>}
      {u?.state === 'available' && !offline && <span className="pill warn" title={u.latestMessage ? 'Newest on GitHub: '+u.latestMessage : ''}>Update available{u.behind ? ' · '+u.behind+' new' : ''}</span>}
      {(u?.state === 'updating' || u?.state === 'restarting') && !offline && <span className="pill"><span className="spinner sm"/> {u.step ?? 'Updating'}</span>}
    </div>
    <div className={'node-now'+(st.current && !offline && !limited ? ' busy' : '')}>{offline ? <span className="muted">Not reachable</span>
      : limited ? <span className="warn-text">YouTube is limiting this node · resumes {new Date(st.rateLimitedUntil).toLocaleTimeString('en-IN', {hour:'2-digit', minute:'2-digit'})}</span>
      : st.current ? <><span className="spinner sm"/><span className="node-now-text" title={st.current}>{st.current}</span></> : <span className="muted">{n.mode === 'active' ? 'Idle, waiting for the next job' : n.mode === 'draining' ? 'Finished its work; taking no new jobs' : 'Not taking any jobs'}</span>}</div>
    <dl className="node-stats">
      <div><dt>CPU</dt><dd>{st.cpu == null ? '—' : st.cpu+'%'}</dd><Meter v={pct(st.cpu)}/><span className="nsub">{st.cpus ?? '—'} cores</span></div>
      <div><dt>Memory</dt><dd>{memUsed == null ? '—' : Math.round(memUsed * 100)+'%'}</dd><Meter v={pct(memUsed == null ? null : memUsed * 100)} warn={90}/><span className="nsub">app {mb(st.rss)}</span></div>
      <div><dt>Disk free</dt><dd>{gb(diskFree)}</dd><span className="nsub">&nbsp;</span></div>
      <div><dt>Up for</dt><dd>{upFor(st.uptime)}</dd></div>
      <div><dt title="Jobs done in the last hour">Jobs / hour</dt><dd>{workTotal ? fmt(workTotal) : '0'}</dd>{workTotal ? <span className="nsub" title={Object.entries(work).map(([k, v]) => v+' '+k).join(', ')}>{Object.entries(work).map(([k, v]) => v+' '+k).join(' · ')}</span> : null}</div>
      <div><dt>DB write</dt><dd>{st.db?.syncError ? <span className="down">failing</span> : st.db?.writeMs != null ? st.db.writeMs+' ms' : '—'}</dd></div>
    </dl>
    {n.leases.length > 0 && <div className="node-leases"><span className="nsub">Holding</span>{n.leases.map(l => <span key={l.name} className="node-job">{jobName(l.name)}</span>)}</div>}
    {u && !offline && (u.lastError || u.blocked || (u.state === 'unavailable' && u.reason)) && <div className="node-note small">{u.lastError ? <span className="down">{u.lastError.message}</span> : <span className="muted">{u.blocked ?? u.reason}</span>}</div>}
    <footer className="node-foot">
      <div className="node-meta">
        <span className="node-links">{n.lan_url && n.lan_url !== n.url && <a href={n.lan_url} target="_blank" rel="noreferrer" title={n.lan_url}>LAN · {host(n.lan_url)}</a>}{n.url && <a href={n.url} target="_blank" rel="noreferrer" title={n.url}>Public link</a>}</span>
        <span className="muted small" title={[u?.commit, n.version, st.node, n.platform].filter(Boolean).join(' · ')}>{[n.version, st.node, n.platform].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="row">
        {u?.state === 'available' && !offline && <button className="btn sm primary" disabled={!!busy || !!u.blocked} title={u.blocked ?? 'Install '+(u.latestMessage ?? 'the newest version')} onClick={() => onUpdate(n)}>Update</button>}
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
      <li>Get the code with <code>git clone</code> from your GitHub repo (then it can update itself from this page), or copy the <code>youtube-dashboard</code> folder without <code>data</code> and <code>node_modules</code>. Then run <code>npm install</code> in it.</li>
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
  if (!d) return <PageSkeleton page="nodes"/>;
  const run = async (k, fn) => { setBusy(k); try { setD(await fn()); } catch (e) { toast(e.message, {kind:'error'}); } finally { setBusy(null); } };
  const onMode = async (n, mode) => {
    if (mode === 'disabled' && !(await ask(`Disable "${n.name}"? It stops its current job and gives it to another node.`, 'Disable'))) return;
    run(n.id, () => api('/api/nodes/'+n.id+'/mode', {method:'POST', body:JSON.stringify({mode})}));
  };
  const onUpdate = async n => {
    if (!(await ask(`Update "${n.name}" to the newest version from GitHub? It restarts and is back within a minute; its current job goes to another node.`, 'Update'))) return;
    setBusy(n.id);
    try { const x = await api('/api/nodes/'+n.id+'/update', {method:'POST'}); setD(x); toast(x.result.message, {kind: x.result.ok ? 'ok' : 'error'}); }
    catch (e) { toast(e.message, {kind:'error'}); } finally { setBusy(null); }
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
        <div className="row">
          <label className="check" title="Nodes installed with git clone check GitHub every 30 minutes and install new versions when they're idle"><input type="checkbox" checked={!!d.autoUpdate} disabled={busy === 'auto'} onChange={e => run('auto', () => api('/api/nodes/auto-update', {method:'POST', body:JSON.stringify({on: e.target.checked})}))}/>Install updates automatically</label>
          <button className="btn" onClick={() => load().then(measure)}>Refresh</button></div></div>
      <div className="nodes">{d.nodes.map(n => <NodeCard key={n.id} n={n} self={n.id === d.self} serving={REMOTE && remoteState().node?.id === n.id} busy={busy} onMode={onMode} onRemove={onRemove} onUpdate={onUpdate} latency={lat[n.id]}/>)}</div>
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

export {NodesPage};
