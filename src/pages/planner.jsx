import React, {useState, useEffect, useMemo} from 'react';
import {nodeFetch} from '../remote.js';
import {duration, fmt, key, thumbProps, today} from '../shared.jsx';

function videoId(value) {
  if (/^[\w-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value.includes('://') ? value : 'https://'+value);
    if (url.hostname === 'youtu.be') return url.pathname.split('/')[1];
    if (['youtube.com','www.youtube.com','m.youtube.com'].includes(url.hostname)) {
      const [, route, id] = url.pathname.split('/');
      if (route === 'watch') return url.searchParams.get('v');
      if (['shorts','live','embed'].includes(route)) return id;
    }
  } catch { return ''; }
  return '';
}

async function fetchVideo(id) {
  let apiError;
  try {
    const response = await nodeFetch('/api/video?id='+encodeURIComponent(id), {signal:AbortSignal.timeout(20000)});
    if ((response.headers.get('content-type') || '').includes('json')) {
      const data = await response.json();
      if (response.ok) return data;
      apiError = data.error;
    }
  } catch (err) { if (err.name === 'TimeoutError') apiError = 'The lookup timed out.'; }
  const response = await fetch('https://www.youtube.com/oembed?format=json&url='+encodeURIComponent('https://www.youtube.com/watch?v='+id), {signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(apiError || 'Video details could not be retrieved. Check that the video is public.');
  const data = await response.json();
  return {id, title:data.title, channel:data.author_name, thumbnail:data.thumbnail_url, partial:true};
}

// ---------- planner ----------
function Planner({own, plans, onSave, onDelete}) {
  const [form, setForm] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [view, setView] = useState('list');
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const t = today();
  const chan = id => own.find(c => c.id === id);
  const items = plans.filter(p => filter === 'all' || String(p.channel) === filter);
  async function lookup(event) {
    event.preventDefault();
    const id = videoId(new FormData(event.currentTarget).get('url').trim());
    setError(''); setResult(null);
    if (!/^[\w-]{11}$/.test(id ?? '')) { setError('Enter a valid YouTube video link or ID.'); return; }
    setBusy(true);
    try { setResult(await fetchVideo(id)); } catch (err) { setError(err.message || 'Video lookup failed.'); } finally { setBusy(false); }
  }
  const newPlan = (extra = {}) => setForm({title:'', channel:filter === 'all' ? own[0]?.id : Number(filter), format:'Long-form', status:'Idea', date:'', ...extra});
  async function submit(event) {
    event.preventDefault();
    const d = Object.fromEntries(new FormData(event.currentTarget));
    try { await onSave({...form, ...d, channel:Number(d.channel)}); setForm(null); } catch (err) { setError(err.message); }
  }
  // Calendar grid: weeks starting Monday.
  const start = new Date(month); start.setDate(1 - (month.getDay()+6)%7);
  const cells = Array.from({length:42}, (_, i) => { const d = new Date(start); d.setDate(start.getDate()+i); return d; });
  const key = d => d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  return <>
    <section className="card">
      <div className="card-head"><h2>Video lookup</h2><span className="muted">Any public video</span></div>
      <form className="lookup" onSubmit={lookup}><input name="url" aria-label="YouTube URL or video ID" placeholder="Paste a YouTube link or video ID" required/><button className="btn primary" disabled={busy}>{busy ? 'Looking up…' : 'Fetch video'}</button></form>
      {error && <p className="error" role="alert">{error}</p>}
      {result && <div className="result">{result.thumbnail && <img decoding="async" loading="lazy" {...thumbProps(result.thumbnail, '320px')} alt="" referrerPolicy="no-referrer"/>}<div>
        <a className="video-title" href={'https://www.youtube.com/watch?v='+result.id} target="_blank" rel="noreferrer">{result.title}</a>
        <p className="muted">{[result.channel, result.views && fmt(result.views)+' views', result.seconds && duration(result.seconds), result.published].filter(Boolean).join(' · ')}</p>
        <button className="btn" onClick={() => newPlan({title:result.title, youtube_id:result.id})}>Add to planner</button>
      </div></div>}
    </section>
    <section className="card">
      <div className="card-head"><div><h2>Upload planner</h2><span className="muted">{['Idea','In production','Scheduled','Published'].map(s => items.filter(v => v.status === s).length+' '+s.toLowerCase()).join(' · ')} · auto-marked Published when the video goes live</span></div>
        <div className="row">
          <div className="seg" role="group" aria-label="View">{['list','calendar'].map(v => <button key={v} aria-pressed={view===v} onClick={() => setView(v)}>{v === 'list' ? 'List' : 'Calendar'}</button>)}</div>
          <select aria-label="Filter by channel" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All channels</option>{own.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <button className="btn primary" onClick={() => newPlan()}>+ Add video</button>
        </div>
      </div>
      {form && <form className="editor" key={form.id || 'new'} onSubmit={submit}>
        <div className="fields">
          <label className="wide">Title<input name="title" defaultValue={form.title} required maxLength="150"/></label>
          <label>Channel<select name="channel" defaultValue={form.channel}>{own.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>Format<select name="format" defaultValue={form.format}>{['Long-form','Short'].map(s => <option key={s}>{s}</option>)}</select></label>
          <label>Status<select name="status" defaultValue={form.status}>{['Idea','In production','Scheduled','Published'].map(s => <option key={s}>{s}</option>)}</select></label>
          <label>Publish date<input type="date" name="date" defaultValue={form.date ?? ''}/></label>
          <label className="wide">Notes<input name="notes" defaultValue={form.notes ?? ''} maxLength="1000"/></label>
        </div>
        <div className="row end"><button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button>{form.id && <button type="button" className="btn danger" onClick={() => { onDelete(form.id); setForm(null); }}>Delete</button>}<button className="btn primary">Save video</button></div>
      </form>}
      {view === 'list' ? (items.length ? <div className="table-wrap"><table>
        <thead><tr><th>Title</th><th>Channel</th><th>Format</th><th>Status</th><th>Publish date</th><th/></tr></thead>
        <tbody>{items.map(v => <tr key={v.id}>
          <td className="title-cell">{v.youtube_id ? <a href={'https://www.youtube.com/watch?v='+v.youtube_id} target="_blank" rel="noreferrer">{v.title}</a> : v.title}{v.notes && <span className="muted small"> · {v.notes}</span>}</td>
          <td><span className="dot" style={{background:chan(v.channel)?.color}}/>{chan(v.channel)?.name ?? '—'}</td><td>{v.format}</td>
          <td><span className={'badge s'+['Idea','In production','Scheduled','Published'].indexOf(v.status)}>{v.status}</span></td>
          <td className={v.date && v.date < t && v.status !== 'Published' ? 'overdue' : ''}>{v.date || '—'}</td>
          <td><button className="btn ghost" onClick={() => setForm(v)}>Edit</button></td>
        </tr>)}</tbody>
      </table></div> : <p className="muted">No videos planned yet.</p>) : <div className="cal">
        <div className="cal-head"><button className="btn ghost" onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth()-1, 1))}>←</button><strong>{month.toLocaleDateString('en-IN', {month:'long', year:'numeric'})}</strong><button className="btn ghost" onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth()+1, 1))}>→</button>
          <span className="muted small">{items.filter(p => !p.date).length} unscheduled</span></div>
        <div className="cal-grid">{['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => <span key={d} className="cal-dow">{d}</span>)}
          {cells.map(d => { const k = key(d); return <div key={k} className={'cal-cell'+(d.getMonth() !== month.getMonth() ? ' out' : '')+(k === t ? ' today' : '')} onDoubleClick={() => newPlan({date:k})}>
            <span className="cal-day">{d.getDate()}</span>
            {items.filter(p => p.date === k).map(p => <button key={p.id} className={'cal-item s'+['Idea','In production','Scheduled','Published'].indexOf(p.status)} style={{'--c':chan(p.channel)?.color}} onClick={() => setForm(p)} title={p.title}>{p.title}</button>)}
          </div>; })}
        </div>
        <p className="muted small">Double-click a day to plan a video on it.</p>
      </div>}
    </section>
  </>;
}

export {Planner};
