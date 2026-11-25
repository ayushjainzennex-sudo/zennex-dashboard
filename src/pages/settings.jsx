import React, {useState, useEffect, useMemo} from 'react';
import {SERVICE_INFO, ago, applyDensity, ask, toast, usePref} from '../shared.jsx';

function DigestCard({cfg, connected, call}) {
  const [busy, setBusy] = useState(null);
  const run = async (k, fn) => { setBusy(k); try { await fn(); } catch (err) { toast(err.message, {kind:'error'}); } finally { setBusy(null); } };
  const set = body => run('set', () => call('/api/settings/digest', {method:'POST', body:JSON.stringify(body)}));
  return <section className="card">
    <div className="card-head"><div><h2>Digest</h2><span className="muted">One summary of growth, outliers, rankings and competitor uploads</span></div>
      <div className="seg sm" role="group" aria-label="Digest frequency">{[['off','Off'],['daily','Daily'],['weekly','Weekly (Mon)']].map(([k, l]) => <button key={k} aria-pressed={cfg.mode === k} disabled={!!busy} onClick={() => set({mode:k})}>{l}</button>)}</div></div>
    <div className="row wrap">
      <label className="inline">Send after <select value={cfg.hour} disabled={!!busy || cfg.mode === 'off'} onChange={e => set({hour:Number(e.target.value)})}>{Array.from({length:24}, (_, h) => <option key={h} value={h}>{String(h).padStart(2,'0')}:00</option>)}</select></label>
      <span className="muted small">{cfg.last ? 'Last sent '+ago(cfg.last) : 'Not sent yet'}{!connected && ' · connect Discord or Slack above'}</span>
      <button className="btn" style={{marginLeft:'auto'}} disabled={!connected || !!busy} onClick={() => run('send', async () => { await call('/api/settings/digest/send', {method:'POST'}); toast('Digest sent.', {kind:'ok'}); })}>{busy === 'send' ? <span className="spinner"/> : 'Send one now'}</button>
    </div>
  </section>;
}

function DisplayCard() {
  const [compactOn, setCompact] = usePref('compact', false);
  return <section className="card">
    <div className="card-head"><div><h2>Display</h2><span className="muted">Compact mode tightens spacing to fit more on smaller screens</span></div>
      <label className="switch"><input type="checkbox" checked={compactOn} onChange={e => { setCompact(e.target.checked); applyDensity(e.target.checked); }}/><span/>Compact</label></div>
    <p className="muted small" style={{margin:0}}>Shortcut: press <kbd>Ctrl</kbd>+<kbd>K</kbd> (<kbd>⌘</kbd>+<kbd>K</kbd> on Mac) anywhere to search.</p>
  </section>;
}

// ---------- settings ----------
const ALERT_KINDS = [['outlier','Outlier videos'],['ranking','Search rankings'],['milestone','Subscriber milestones'],['published','Planned video published']];

function WebhookCard({id, cfg, call}) {
  const info = SERVICE_INFO[id];
  const [editing, setEditing] = useState(!cfg.configured);
  const [msg, setMsg] = useState(null); // {ok, text}
  const [busy, setBusy] = useState(null);
  const save = async (body, label) => {
    setBusy(label); setMsg(null);
    try { await call('/api/settings/'+id, {method:'POST', body:JSON.stringify(body)}); return true; }
    catch (err) { setMsg({ok:false, text:err.message}); return false; }
    finally { setBusy(null); }
  };
  async function submit(e) {
    e.preventDefault();
    const url = new FormData(e.currentTarget).get('url').trim();
    if (await save({url, enabled:true}, 'save')) { setEditing(false); setMsg({ok:true, text:'Saved. Send a test to confirm it works.'}); }
  }
  async function test() {
    setBusy('test'); setMsg(null);
    try { await call('/api/settings/'+id+'/test', {method:'POST'}); setMsg({ok:true, text:'Sent a connection message and a sample “Lost #1” alert. Check '+info.name+'.'}); }
    catch (err) { setMsg({ok:false, text:err.message}); }
    finally { setBusy(null); }
  }
  const toggleKind = k => save({kinds: cfg.kinds.includes(k) ? cfg.kinds.filter(x => x !== k) : [...cfg.kinds, k]}, 'kind');
  const status = !cfg.configured ? ['', 'Not connected'] : !cfg.enabled ? ['', 'Paused'] : cfg.lastError ? ['bad', 'Failing'] : ['good', 'Connected'];

  return <section className="card hook">
    <div className="card-head">
      <div className="hook-title"><span className="hook-logo" style={{background:info.color}}>{info.name[0]}</span><div><h2>{info.name}</h2><span className={'status '+status[0]}><i/>{status[1]}{cfg.lastSent ? ' · last sent '+ago(cfg.lastSent) : ''}</span></div></div>
      {cfg.configured && <label className="switch" title={cfg.enabled ? 'Pause' : 'Resume'}><input type="checkbox" checked={cfg.enabled} disabled={!!busy} onChange={e => save({enabled:e.target.checked}, 'toggle')}/><span/>{cfg.enabled ? 'On' : 'Off'}</label>}
    </div>
    {editing ? <form onSubmit={submit} className="hook-form">
      <label>Webhook URL<input name="url" type="url" required autoComplete="off" spellCheck="false" placeholder={cfg.hint} defaultValue=""/></label>
      <p className="muted small">Where to find it: {info.how}</p>
      <div className="row end">{cfg.configured && <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>}<button className="btn primary" disabled={busy === 'save'}>{busy === 'save' ? <span className="spinner"/> : 'Save'}</button></div>
    </form> : <>
      <div className="hook-url"><code>{cfg.masked}</code>{cfg.fromEnv && <span className="muted small">from DISCORD_WEBHOOK_URL</span>}
        <div className="row"><button className="link-btn" onClick={() => setEditing(true)}>Change</button>
          <button className="link-btn danger" onClick={() => ask(`Disconnect ${info.name}? Alerts will stop being sent there.`, 'Disconnect').then(ok => ok && save({url:''}, 'remove').then(() => setEditing(true)))}>Disconnect</button>
          <button className="btn" disabled={!!busy} onClick={test}>{busy === 'test' ? <span className="spinner"/> : 'Send test'}</button></div></div>
      <div className="kinds"><span className="kpi-label">Send these alerts</span>
        <div className="kind-list">{ALERT_KINDS.map(([k, label]) => <label key={k} className="check"><input type="checkbox" checked={cfg.kinds.includes(k)} disabled={!!busy} onChange={() => toggleKind(k)}/>{label}</label>)}</div></div>
    </>}
    {(msg || cfg.lastError) && <p className={'hook-msg '+((msg ? msg.ok : false) ? 'ok' : 'err')}>{msg ? msg.text : 'Last delivery failed: '+cfg.lastError}</p>}
  </section>;
}

function Settings({data, call}) {
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  return <>
    <div className="settings-grid">
      <WebhookCard id="discord" cfg={data.notifications.discord} call={call}/>
      <WebhookCard id="slack" cfg={data.notifications.slack} call={call}/>
    </div>
    <DigestCard cfg={data.notifications.digest} connected={data.notifications.discord.enabled || data.notifications.slack.enabled} call={call}/>
    <DisplayCard/>
    <section className="card">
      <div className="card-head"><div><h2>Desktop notifications</h2><span className="muted">Shown by this browser while the dashboard is open</span></div>
        {perm === 'default' && <button className="btn" onClick={() => Notification.requestPermission().then(setPerm)}>Enable</button>}
        {perm === 'granted' && <span className="status good"><i/>On</span>}
        {perm === 'denied' && <span className="muted small">Blocked. Allow notifications for this site in your browser settings.</span>}
        {perm === 'unsupported' && <span className="muted small">Not supported in this browser.</span>}
      </div>
    </section>
    <p className="muted small">Webhook URLs are stored only in your local database (data/dashboard.db) and are never shown in full again. Anyone with a webhook URL can post to that channel, so keep it private.</p>
  </>;
}

export {Settings};
