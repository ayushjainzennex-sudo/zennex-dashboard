import React, {useState, useEffect, useMemo} from 'react';
import {AlertList, SERVICE_INFO} from '../shared.jsx';

function Alerts({data, onRead, onSettings}) {
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  return <>
    <section className="card">
      <div className="card-head"><div><h2>Notifications</h2><span className="muted">Checked on every hourly update</span></div>
        <div className="row">
          {perm === 'default' && <button className="btn" onClick={() => Notification.requestPermission().then(setPerm)}>Enable desktop notifications</button>}
          {perm === 'granted' && <span className="chip chip-up">Desktop notifications on</span>}
          {perm === 'denied' && <span className="chip">Desktop notifications blocked in browser settings</span>}
          <span className="chip">{['discord','slack'].filter(k => data.notifications[k].enabled).map(k => SERVICE_INFO[k].name).join(' + ') || 'No webhooks'} · <a className="inline-link" href="#settings" onClick={e => { e.preventDefault(); onSettings(); }}>Settings</a></span>
          {data.unread > 0 && <button className="btn" onClick={onRead}>Mark all read</button>}
        </div>
      </div>
      <AlertList alerts={data.alerts} channels={data.channels}/>
    </section>
  </>;
}

export {Alerts};
