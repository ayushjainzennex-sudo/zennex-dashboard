import React, {useState, useEffect, useMemo} from 'react';
import {Kpi, PageSkeleton, ago, agoS, api, ask, fmt, mb, short, shortDate, toast} from '../shared.jsx';

const SETTINGS_UI = [
  ['Backups', [
    ['backupEveryHours', 'Back up every', 'hours', 'How often a checked copy of the database is saved.', [6, 168]],
    ['backupKeepDays', 'Keep daily backups for', 'days', 'Older backups are deleted (the 3 newest are always kept).', [3, 90]]]],
  ['Data retention', [
    ['rankResultsDays', 'Keep ranking checks for', 'days', 'Older search-ranking checks are deleted. 0 keeps them forever.', [0, 3650]],
    ['thinSnapshotsDays', 'Thin video view history after', 'days', 'Older view snapshots are reduced to one per day per video (a video’s first 4 days stay hourly). 0 never thins.', [0, 3650]],
    ['thinChannelDays', 'Thin channel history after', 'days', 'Older subscriber/view snapshots are reduced to one per day per channel. 0 never thins.', [0, 3650]],
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
        <button className="btn" disabled={!!busy} onClick={() => act('ping', 'Connection')}>{busy === 'ping' ? <span className="spinner"/> : 'Test connection'}</button>
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
  if (!h) return <PageSkeleton page="database"/>;
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
      <button className="btn" disabled={!!busy} onClick={() => run('now', async () => { const r = await api('/api/backups', {method:'POST'}); toast('Backup saved.', {kind:'ok'}); return r; })}>{busy === 'now' ? <span className="spinner"/> : 'Back up now'}</button></div>
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

export {DatabasePage};
