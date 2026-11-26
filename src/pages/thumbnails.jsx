// Thumbnails: a wall of recent thumbnails from tracked creators (competitors, and your own channels if picked),
// filtered by creator, format and period, sorted by newest, most viewed or outlier score.
// Uses each channel's stored uploads (c.pool: the latest 80 per channel, already scored), plus creators added only
// here (server/thumbs.js), scored the same way against their own median per format.
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Avatar, DAY, ago, api, fmt, median, pref, setPref, short, thumbProps, toast} from '../shared.jsx';

// A creator added only for this page, shaped like a channel so the rest of the page treats it the same.
function asChannel(x) {
  const base = {};
  for (const f of [true, false]) base[f] = median(x.uploads.filter(v => v.short === f && v.views != null).map(v => v.views));
  return {id:'x:'+x.channelId, channelId:x.channelId, kind:'extra', name:x.name, avatar:x.avatar, color:x.color,
    pool:x.uploads.map(v => ({...v, thumbnail:`https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`, score:base[v.short] ? v.views / base[v.short] : null}))};
}

const SORTS = [['recent', 'Newest'], ['views', 'Most viewed'], ['score', 'Outliers']];
const FORMATS = [['all', 'All'], ['video', 'Videos'], ['short', 'Shorts']];
const PERIODS = [['7', '7D', 7], ['28', '28D', 28], ['90', '3M', 90], ['all', 'All', Infinity]];
const PAGE = 48;
const DEFAULTS = {picked:null, sort:'recent', format:'video', period:'28', categories:[], category:null};

// Filters live in this browser (instant on load) and in the database (same after a refresh on any device or site).
function useThumbPrefs() {
  const [p, set] = useState(() => ({...DEFAULTS, picked:pref('thumbCreators', null), ...pref('thumbPrefs', {})}));   // thumbCreators: the earlier key
  const timer = useRef(0), touched = useRef(false);
  useEffect(() => { api('/api/thumbs/prefs').then(r => { if (!touched.current && r && Object.keys(r).length) { set(x => ({...x, ...r})); setPref('thumbPrefs', {...pref('thumbPrefs', {}), ...r}); } }, () => {}); }, []);
  const update = patch => set(x => {
    const next = {...x, ...(typeof patch === 'function' ? patch(x) : patch)}; touched.current = true; setPref('thumbPrefs', next);
    clearTimeout(timer.current); timer.current = setTimeout(() => api('/api/thumbs/prefs', {method:'PUT', body:JSON.stringify(next)}).catch(() => {}), 400);
    return next;
  });
  return [p, update];
}

const watchUrl = v => 'https://www.youtube.com/'+(v.short ? 'shorts/' : 'watch?v=')+v.id;
const big = v => `https://i.ytimg.com/vi/${v.id}/maxresdefault.jpg`;
const copy = (text, what) => navigator.clipboard.writeText(text).then(() => toast('Copied '+what), () => toast('Copy failed', {kind:'error'}));
async function download(v) {
  for (const u of [big(v), `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`]) {
    try {
      const r = await fetch(u, {referrerPolicy:'no-referrer'});
      if (!r.ok) continue;
      const blob = await r.blob(); if (blob.size < 2000) continue;   // YouTube's grey placeholder when there's no max-res
      const a = Object.assign(document.createElement('a'), {href:URL.createObjectURL(blob), download:(v.title ?? v.id).replace(/[\\/:*?"<>|]+/g, '').slice(0, 80)+'.jpg'});
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); return;
    } catch {}
  }
  window.open(big(v), '_blank', 'noreferrer');   // the image host refused a direct download: open it to save by hand
}

// Right-click menu: a list of {label, run} items (null = divider), placed at the pointer and kept on screen.
function Menu({menu, close}) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(menu.x, innerWidth - r.width - 8))+'px'; el.style.top = Math.max(8, Math.min(menu.y, innerHeight - r.height - 8))+'px';
    el.querySelector('button')?.focus({preventScroll:true});
    const off = e => { if (!el.contains(e.target)) close(); };
    const key = e => { if (e.key === 'Escape') close();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const b = [...el.querySelectorAll('button')], i = b.indexOf(document.activeElement); b[(i + (e.key === 'ArrowDown' ? 1 : -1) + b.length) % b.length]?.focus(); } };
    addEventListener('pointerdown', off, true); addEventListener('keydown', key); addEventListener('scroll', close, true); addEventListener('resize', close); addEventListener('blur', close);
    return () => { removeEventListener('pointerdown', off, true); removeEventListener('keydown', key); removeEventListener('scroll', close, true); removeEventListener('resize', close); removeEventListener('blur', close); };
  }, [menu]);
  return <div ref={ref} className="ctx-menu" role="menu" style={{left:menu.x, top:menu.y}} onContextMenu={e => e.preventDefault()}>
    {menu.title ? <div className="ctx-title">{menu.title}</div> : null}
    {menu.items.map((it, i) => it ? <button key={i} role="menuitem" className={it.danger ? 'danger' : ''} onClick={() => { close(); it.run(); }}>{it.label}</button> : <hr key={i}/>)}
  </div>;
}

function Thumbnails({channels: tracked}) {
  const [extra, setExtra] = useState([]), [input, setInput] = useState(''), [adding, setAdding] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => { api('/api/thumbs/creators').then(l => setExtra(l.map(asChannel)), () => {}).finally(() => setReady(true)); }, []);
  const channels = useMemo(() => [...tracked, ...extra], [tracked, extra]);
  const rivals = tracked.filter(c => c.kind === 'competitor'), own = tracked.filter(c => c.kind === 'own');
  const [prefs, update] = useThumbPrefs(), {picked, sort, format, period, categories = [], category} = prefs;   // picked null = competitors + added creators
  // Categories: named groups of creators. With one open, the chips show and edit that category's members.
  const cat = categories.find(c => c.id === category) ?? null;
  const [naming, setNaming] = useState(null);   // {id: category id or 'new', name}
  const saveCats = (list, patch = {}) => update({categories:list, ...patch});
  const openCat = id => { update({category:id}); setShown(PAGE); };
  const nameDone = () => {
    const name = naming?.name.trim(); if (!naming) return;
    setNaming(null);
    if (!name) return;
    if (categories.some(c => c.name.toLowerCase() === name.toLowerCase() && c.id !== naming.id)) return toast('There is already a category called '+name, {kind:'error'});
    if (naming.id === 'new') { const id = Date.now().toString(36); saveCats([...categories, {id, name, members:naming.members ?? []}], {category:id}); toast('Created '+name+(naming.members?.length ? '' : ' · click creators to add them')); }
    else saveCats(categories.map(c => c.id === naming.id ? {...c, name} : c));
  };
  const deleteCat = c => {
    const before = categories;
    saveCats(categories.filter(x => x.id !== c.id), category === c.id ? {category:null} : {});
    toast('Deleted '+c.name, {action:{label:'Undo', run:() => saveCats(before, {category:c.id})}});
  };
  const setMember = (c, id, inIt) => update(p => ({categories:(p.categories ?? []).map(x => x.id === c.id ? {...x, members:inIt ? [...new Set([...x.members, id])] : x.members.filter(m => m !== id)} : x)}));
  const catMenu = (e, c) => at(e, c.name, [
    {label:'Open', run:() => openCat(c.id)},
    {label:'Rename', run:() => setNaming({id:c.id, name:c.name})},
    {label:'Duplicate', run:() => setNaming({id:'new', name:c.name+' copy', members:c.members})},
    {label:'Clear creators', run:() => saveCats(categories.map(x => x.id === c.id ? {...x, members:[]} : x))},
    null,
    {label:'Delete category', danger:true, run:() => deleteCat(c)},
  ]);
  const setPicked = v => update({picked:v}), setSort = v => update({sort:v}), setFormat = v => update({format:v}), setPeriod = v => update({period:v});
  const [shown, setShown] = useState(PAGE), [menu, setMenu] = useState(null);
  // ids of creators that no longer exist are ignored, but only once the added creators have loaded (so they aren't dropped)
  const ids = new Set(channels.map(c => c.id)), saved = picked && (ready ? picked.filter(id => ids.has(id)) : picked);
  const on = new Set(cat ? cat.members.filter(id => !ready || ids.has(id)) : saved ?? [...rivals, ...extra].map(c => c.id));
  const add = async e => {
    e.preventDefault(); if (!input.trim() || adding) return;
    setAdding(true);
    try { const c = asChannel(await api('/api/thumbs/creators', {method:'POST', body:JSON.stringify({input:input.trim()})})); setExtra(l => [...l, c]); if (picked) setPicked([...picked, c.id]); setInput(''); toast('Added '+c.name+' to Thumbnails'); }
    catch (err) { toast(err.message, {kind:'error'}); }
    setAdding(false);
  };
  const remove = async c => {
    try { await api('/api/thumbs/creators/'+c.channelId, {method:'DELETE'}); setExtra(l => l.filter(x => x.id !== c.id)); if (picked) setPicked(picked.filter(id => id !== c.id)); toast('Removed '+c.name); }
    catch (err) { toast(err.message, {kind:'error'}); }
  };
  const toggle = id => { if (cat) return setMember(cat, id, !on.has(id)); const s = new Set(on); s.has(id) ? s.delete(id) : s.add(id); setPicked([...s]); setShown(PAGE); };
  const pick = list => { if (cat) saveCats(categories.map(x => x.id === cat.id ? {...x, members:list.map(c => c.id)} : x)); else setPicked(list.map(c => c.id)); setShown(PAGE); };
  const openCreator = c => c.kind === 'extra' ? window.open('https://www.youtube.com/channel/'+c.channelId, '_blank', 'noreferrer') : (location.hash = 'ch:'+c.id);
  const at = (e, title, items) => { e.preventDefault(); setMenu({x:e.clientX, y:e.clientY, title, items}); };
  const creatorMenu = (e, c) => at(e, c.name, [
    {label:on.has(c.id) ? 'Hide this creator' : 'Show this creator', run:() => toggle(c.id)},
    {label:'Show only this creator', run:() => pick([c])},
    {label:'Show everyone except this', run:() => pick(channels.filter(x => x.id !== c.id))},
    null,
    {label:c.kind === 'extra' ? 'Open channel on YouTube' : 'Open channel page', run:() => openCreator(c)},
    ...(categories.length ? [null, ...categories.map(k => { const inIt = k.members.includes(c.id); return {label:(inIt ? '✓ In ' : 'Add to ')+k.name, run:() => setMember(k, c.id, !inIt)}; })] : []),
    {label:'New category with this creator…', run:() => setNaming({id:'new', name:'', members:[c.id]})},
    ...(c.kind === 'extra' ? [null, {label:'Remove from Thumbnails', danger:true, run:() => remove(c)}] : [])
  ]);
  const thumbMenu = (e, v) => at(e, v.title, [
    {label:'Open video', run:() => window.open(watchUrl(v), '_blank', 'noreferrer')},
    {label:'View thumbnail full size', run:() => window.open(big(v), '_blank', 'noreferrer')},
    {label:'Download thumbnail', run:() => download(v)},
    null,
    {label:'Copy video link', run:() => copy(watchUrl(v), 'video link')},
    {label:'Copy title', run:() => copy(v.title ?? '', 'title')},
    {label:'Copy thumbnail link', run:() => copy(big(v), 'thumbnail link')},
    null,
    {label:'Show only '+v.ch.name, run:() => pick([v.ch])},
    {label:'Hide '+v.ch.name, run:() => on.has(v.ch.id) && toggle(v.ch.id)},
    {label:v.ch.kind === 'extra' ? 'Open '+v.ch.name+' on YouTube' : 'Open '+v.ch.name+'’s page', run:() => openCreator(v.ch)},
  ]);

  const list = useMemo(() => {
    const days = PERIODS.find(p => p[0] === period)?.[2] ?? 28, from = Date.now() - days * DAY;
    const all = channels.filter(c => on.has(c.id)).flatMap(c => (c.pool ?? []).map(v => ({...v, ch:c})))
      .filter(v => v.thumbnail && (format === 'all' || (format === 'short') === !!v.short) && new Date(v.published) >= from);
    const by = {recent: (a, b) => new Date(b.published) - new Date(a.published), views: (a, b) => (b.views ?? 0) - (a.views ?? 0), score: (a, b) => (b.score ?? -1) - (a.score ?? -1)};
    return all.sort(by[sort] ?? by.recent);
  }, [channels, picked, sort, format, period, extra, cat]);

  const Chip = ({c}) => <button className={'tchip'+(on.has(c.id) ? ' on' : '')} style={{'--c':c.color}} aria-pressed={on.has(c.id)} onClick={() => toggle(c.id)} onContextMenu={e => creatorMenu(e, c)}>
    <Avatar channel={c} size={20}/><span>{c.name}</span>{c.kind === 'extra' ? <span className="tchip-x" role="button" aria-label={'Remove '+c.name} title="Remove from Thumbnails" onClick={e => { e.stopPropagation(); remove(c); }}>×</span> : null}</button>;

  return <>
    <section className="card">
      <div className="tcats" role="tablist" aria-label="Categories">
        <button role="tab" aria-selected={!cat} className={'tcat'+(!cat ? ' on' : '')} onClick={() => openCat(null)}>All creators</button>
        {categories.map(c => naming?.id === c.id ? <NameInput key={c.id} naming={naming} setNaming={setNaming} done={nameDone}/>
          : <button key={c.id} role="tab" aria-selected={cat?.id === c.id} className={'tcat'+(cat?.id === c.id ? ' on' : '')} onClick={() => openCat(c.id)}
              onDoubleClick={() => setNaming({id:c.id, name:c.name})} onContextMenu={e => catMenu(e, c)} title="Double-click to rename, right-click for more">
              {c.name}<span className="tcat-n">{c.members.filter(id => !ready || ids.has(id)).length}</span></button>)}
        {naming?.id === 'new' ? <NameInput naming={naming} setNaming={setNaming} done={nameDone}/>
          : <button className="tcat tcat-new" onClick={() => setNaming({id:'new', name:''})}>+ New category</button>}
      </div>
      <div className="card-head"><div><h2>{cat ? cat.name : 'Creators'}</h2><span className="muted">{cat ? 'Click creators to add them to or remove them from this category · ' : ''}{on.size} selected · {list.length} thumbnail{list.length === 1 ? '' : 's'}</span></div>
        <div className="row">{cat ? <><button className="link-btn" onClick={() => setNaming({id:cat.id, name:cat.name})}>Rename</button><button className="link-btn danger" onClick={() => deleteCat(cat)}>Delete</button></> : null}<button className="link-btn" onClick={() => pick([...rivals, ...extra])}>{cat ? 'Competitors' : 'Default'}</button><button className="link-btn" onClick={() => pick(channels)}>Everyone</button><button className="link-btn" onClick={() => pick([])}>None</button></div></div>
      <div className="tchips">{rivals.map(c => <Chip key={c.id} c={c}/>)}</div>
      <span className="kpi-label" style={{display:'block', margin:'14px 0 8px'}}>Added for thumbnails only</span>
      <div className="tchips">{extra.map(c => <Chip key={c.id} c={c}/>)}
        <form className="tadd" onSubmit={add}><input value={input} onChange={e => setInput(e.target.value)} placeholder="@handle or channel link" aria-label="Add a creator"/><button className="btn" disabled={adding || !input.trim()}>{adding ? <span className="spinner"/> : '+'} Add</button></form></div>
      {own.length ? <><span className="kpi-label" style={{display:'block', margin:'14px 0 8px'}}>Your channels</span><div className="tchips">{own.map(c => <Chip key={c.id} c={c}/>)}</div></> : null}
    </section>
    <div className="toolbar thumb-bar">
      <div className="seg" role="group" aria-label="Sort">{SORTS.map(([k, l]) => <button key={k} aria-pressed={sort === k} onClick={() => setSort(k)}>{l}</button>)}</div>
      <div className="seg sm" role="group" aria-label="Format">{FORMATS.map(([k, l]) => <button key={k} aria-pressed={format === k} onClick={() => { setFormat(k); setShown(PAGE); }}>{l}</button>)}</div>
      <div className="seg sm" role="group" aria-label="Period">{PERIODS.map(([k, l]) => <button key={k} aria-pressed={period === k} onClick={() => { setPeriod(k); setShown(PAGE); }}>{l}</button>)}</div>
    </div>
    {list.length ? <div className="thumb-wall">{list.slice(0, shown).map(v => <a key={v.ch.id+v.id} className="twall" href={watchUrl(v)} target="_blank" rel="noreferrer" onContextMenu={e => thumbMenu(e, v)}>
      <div className="thumb"><img {...thumbProps(v.thumbnail, '(max-width:640px) 90vw, 320px')} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"/>
        {v.short ? <span className="twall-tag">Short</span> : null}
        {v.score != null && v.score >= 2 ? <span className="twall-score">{v.score.toFixed(1)}×</span> : null}</div>
      <span className="video-title">{v.title}</span>
      <span className="video-meta"><span className="dot" style={{background:v.ch.color}}/>{v.ch.name} · {short(v.views)} views · {ago(v.published)}</span>
    </a>)}</div> : <div className="spark-empty">{on.size ? 'No uploads match these filters.' : 'Pick at least one creator.'}</div>}
    {menu ? <Menu menu={menu} close={() => setMenu(null)}/> : null}
    {shown < list.length ? <button className="btn show-more-btn" onClick={() => setShown(n => n + PAGE)}>Show {Math.min(PAGE, list.length - shown)} more of {fmt(list.length - shown)}</button> : null}
  </>;
}

// Inline name field for a new or renamed category: Enter saves, Esc cancels, leaving the field saves.
function NameInput({naming, setNaming, done}) {
  return <input className="tcat-input" autoFocus value={naming.name} placeholder="Category name, e.g. Laptops" maxLength={40}
    onChange={e => setNaming({...naming, name:e.target.value})} onBlur={done}
    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); done(); } if (e.key === 'Escape') setNaming(null); }}/>;
}

export {Thumbnails};
