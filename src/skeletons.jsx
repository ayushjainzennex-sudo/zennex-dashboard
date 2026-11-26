// Loading skeletons, one per page, built from the same layout classes as the real page (.kpis, .card,
// .channel-card, .list-row, .split, .ov-layout …) so the placeholder has the page's shape and the content
// lands where the grey blocks were. Text is drawn as a bar inside a box as tall as the real line, so
// heights match too. How many channel cards to draw comes from the last load (remembered in `skel`).
import React from 'react';
import {pref} from './shared.jsx';

const Sk = ({w = '100%', h = 12, r = 6, style}) => <span className="sk" style={{width:w, height:h, borderRadius:r, flex:'none', ...style}}/>;
// One line of text: a box of the line's height with a bar about as tall as the letters.
const T = ({w = '60%', lh = 17, h = Math.round(lh * .62), style}) => <span className="sk-line" style={{height:lh, width:w, ...style}}><Sk h={h} r={h/2}/></span>;
const range = n => Array.from({length:n}, (_, i) => i);
// Stable, uneven widths so rows don't look stamped out.
const vary = (i, a, b) => a + ((i * 37 + 11) % 100) / 100 * (b - a) + '%';

const Head = ({title = 30, sub = 50, right}) => <div className="card-head">
  <div style={{display:'grid', flex:1, minWidth:0}}><T w={title+'%'} lh={24} h={15}/>{sub ? <T w={sub+'%'} h={10}/> : null}</div>
  {right}
</div>;
const Btn = ({w = 110}) => <Sk w={w} h={37} r={10}/>;
const Seg = ({n = 3, w = 80, h = 40}) => <Sk w={n * w + 4} h={h} r={10}/>;

const Kpis = ({n = 4, six}) => <section className={'kpis'+(six ? ' six' : '')}>
  {range(n).map(i => <div key={i} className="kpi"><T w={vary(i, 40, 60)} lh={18} h={10}/><T w={vary(i+3, 50, 72)} lh={31} h={24}/><T w={vary(i+5, 35, 60)} lh={18} h={10}/></div>)}
</section>;

const Strip = () => <div className="ustrip">{range(16).map(i => <Sk key={i} h={6 + ((i * 53 + 7) % 34)} r={3} style={{flex:1, alignSelf:'flex-end'}}/>)}</div>;
const ChannelCards = ({n = 3}) => <section className="channel-cards">
  {range(n).map(i => <div key={i} className="channel-card sk-card" style={{'--c':'var(--border)'}}>
    <div className="cc-head"><Sk w={44} h={44} r={22}/><div style={{flex:1, gap:4}}><T w={vary(i, 30, 50)} lh={20} h={13}/><T w={vary(i+2, 20, 35)} lh={18} h={10}/></div></div>
    <div className="cc-stats">{range(3).map(j => <div key={j}><T w="55%" lh={18} h={9}/><T w="70%" lh={29} h={18}/><T w="45%" lh={18} h={9}/></div>)}</div>
    <Strip/>
    <div className="cc-foot"><T w={120} lh={18} h={9}/><T w={110} lh={18} h={9}/></div>
  </div>)}
</section>;

const ListRows = ({n = 5}) => <div className="list">{range(n).map(i => <div key={i} className="list-row">
  <Sk w={96} h={54} r={8}/>
  <div className="list-main"><T w={vary(i, 60, 90)} lh={20} h={12}/><T w={vary(i+4, 30, 50)} h={10}/></div>
  <div style={{display:'grid', justifyItems:'end'}}><T w={56} lh={22} h={14}/><T w={40} h={9}/></div>
</div>)}</div>;

const Table = ({rows = 6, cols = 5, lh = 20}) => <div className="table-wrap"><table><thead><tr>{range(cols).map(j => <th key={j}><T w={j ? 50 : 90} lh={16} h={9}/></th>)}</tr></thead>
  <tbody>{range(rows).map(i => <tr key={i}>{range(cols).map(j => <td key={j}>{j ? <T w={vary(i+j, 40, 70)} lh={lh} h={11}/>
    : <span className="row" style={{gap:8}}><Sk w={22} h={22} r={11}/>{lh > 30 ? <span style={{display:'grid'}}><T w={vary(i, 90, 140)} lh={24} h={11}/><T w={70} lh={22} h={9}/></span> : <T w={vary(i, 90, 140)} lh={lh} h={11}/>}</span>}</td>)}</tr>)}</tbody></table></div>;

const AlertRows = ({n = 7}) => <div className="list">{range(n).map(i => <div key={i} className="alert-row">
  <Sk w={32} h={32} r={9}/><div className="list-main"><T w={vary(i, 50, 85)} lh={20} h={12}/>{i % 3 ? <T w={vary(i+1, 30, 60)} h={10}/> : null}</div><T w={36} lh={18} h={9}/>
</div>)}</div>;

const RailCard = ({rows = 4, thumbs}) => <section className="card rail-card">
  <div className="rail-head"><T w="45%" lh={21} h={12}/><T w={40} lh={17} h={9}/></div>
  <div style={{display:'grid', gap:10}}>{range(rows).map(i => <div key={i} className="row" style={{gap:8}}>
    {thumbs ? <Sk w={64} h={36} r={6}/> : <Sk w={18} h={18} r={9}/>}
    <div style={{flex:1, display:'grid', gap:2}}><T w={vary(i, 55, 90)} lh={18} h={10}/>{thumbs ? <T w="40%" lh={15} h={8}/> : null}</div>
  </div>)}</div>
</section>;

const Lookup = ({btn = 110}) => <div className="lookup"><Sk h={39} r={10} style={{flex:'1 1 260px', width:'auto'}}/><Btn w={btn}/></div>;
const Toolbar = ({children, spread}) => <div className={'toolbar'+(spread ? ' spread' : '')}>{children}</div>;
const Card = ({children, className = '', ...head}) => <section className={'card '+className}><Head {...head}/>{children}</section>;

// ---------- pages ----------
const counts = () => pref('skel', {own:3, rivals:{}});

const Overview = () => <div className="ov-layout">
  <div className="ov-main">
    <Kpis/>
    <ChannelCards n={counts().own ?? 3}/>
    <div className="split"><Card title={40} sub={60}><ListRows n={5}/></Card><Card title={45} sub={55}><AlertRows n={5}/></Card></div>
    <Card title={30} sub={45}><ListRows n={5}/></Card>
  </div>
  <aside className="ov-rail"><RailCard rows={3}/><RailCard rows={5}/><RailCard rows={4} thumbs/><RailCard rows={3}/><RailCard rows={3}/></aside>
</div>;

const Channel = () => <>
  <section className="hero sk-card" style={{'--c':'var(--border)'}}><Sk w={84} h={84} r={42}/>
    <div className="hero-text" style={{display:'grid', gap:4}}><T w="45%" lh={36} h={22}/><T w="60%" lh={21} h={11}/><T w="40%" lh={21} h={11}/><T w="85%" lh={19} h={10}/><T w="70%" lh={19} h={10}/></div>
    <Btn w={165}/></section>
  <Kpis n={6} six/>
  <div className="projection"><T w={86} lh={18} h={10}/><T w={260} lh={24} h={14}/></div>
  <section className="periods">{range(3).map(i => <div key={i} className="period"><T w="50%" lh={20} h={10}/><div style={{display:'grid'}}><T w="60%" lh={44} h={30}/><T w="45%" lh={24} h={9}/></div><div style={{display:'grid'}}><T w="85%" lh={19} h={9}/><T w="60%" lh={19} h={9}/></div>
    {range(2).map(j => <div key={j} className="period-row">{range(2).map(k => <div key={k}><T w="60%" lh={18} h={9}/><T w="75%" lh={34} h={20}/><T w="50%" lh={18} h={9}/></div>)}</div>)}</div>)}</section>
  <Card title={40} sub={55} className="csearch"><Lookup btn={79}/></Card>
  <Card title={35} sub={60}><ListRows n={5}/></Card>
</>;

const Competitors = ({page}) => {
  const {rivals = {}} = counts(), n = rivals[page.split(':')[1]] ?? Object.values(rivals)[0];
  return <>
    <Toolbar><Seg n={3} w={120}/></Toolbar>
    <Card title={45} sub={65}><Lookup btn={149}/><div className="tags">{range(4).map(i => <Sk key={i} w={140 + (i * 17) % 40} h={30} r={15}/>)}</div></Card>
    <ChannelCards n={n ?? 3}/>
    <Card title={30} sub={0}><Table rows={4} cols={7}/></Card>
  </>;
};

const Rankings = () => <>
  <Toolbar spread><div className="row"><Seg n={5} w={92}/></div><div className="row"><T w={94} lh={18} h={10}/><Btn w={157}/></div></Toolbar>
  <div className="worker-strip"><Sk w={8} h={8} r={4}/><T w="60%" lh={20} h={11}/><Sk w={200} h={6} r={3} style={{marginLeft:'auto'}}/><T w="100%" lh={18} h={9}/></div>
  <Card title={30} sub={45} right={<Btn w={171}/>}><Table rows={10} cols={6} lh={46}/></Card>
  <Card title={40} sub={55}><div className="rivals">{range(5).map(i => <div key={i} className="rival"><T w={16} lh={21} h={11}/>
    <div className="rival-main"><T w={vary(i, 50, 80)} lh={21} h={12}/><T w="40%" lh={18} h={9}/></div><div className="rival-stat"><T w="50%" lh={16} h={9}/><Sk h={6} r={3}/></div></div>)}</div></Card>
</>;

const Insights = () => <>
  <Toolbar><Sk w={183} h={37} r={10}/><T w={320} lh={18} h={10}/></Toolbar>
  <div className="split">
    <Card title={45} sub={60}><div style={{display:'grid', gridTemplateColumns:'42px repeat(7,1fr)', gap:4}}>{range(56).map(i => i % 8 ? <Sk key={i} h={37} r={6}/> : <T key={i} w={30} lh={37} h={9}/>)}</div></Card>
    <Card title={35} sub={50}><div style={{display:'grid', gap:10}}>{range(6).map(i => <div key={i} className="row" style={{gap:8}}><T w={70} lh={20} h={10}/><Sk w={vary(i, 30, 80)} h={14} r={7}/></div>)}</div>
      <div className="mixrow" style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginTop:16}}>{range(2).map(i => <Sk key={i} h={70} r={10}/>)}</div></Card>
  </div>
  <Card title={40} sub={55}><div className="kw-grid">{[10, 5].map(n => <div key={n} style={{display:'grid', gap:6}}><T w={110} lh={18} h={10}/>{range(n).map(i => <div key={i} className="row" style={{gap:8}}><T w={vary(i, 20, 35)} lh={20} h={11}/><Sk w={vary(i+2, 20, 50)} h={10} r={5}/></div>)}</div>)}</div></Card>
</>;

const Report = () => <div className="report">
  <Toolbar spread><T w={245} lh={21} h={11}/><Btn w={159}/></Toolbar>
  <Kpis/>
  <Card title={18} sub={0}><Table rows={4} cols={6}/></Card>
  <Card title={16} sub={0}><Table rows={3} cols={6}/></Card>
  <Card title={14} sub={0}><AlertRows n={5}/></Card>
</div>;

const Alerts = () => <Card title={30} sub={40} right={<div className="row"><Sk w={200} h={24} r={12}/><Sk w={100} h={24} r={12}/></div>}><AlertRows n={10}/></Card>;

const Planner = () => <>
  <Card title={18} sub={0}><Lookup/></Card>
  <Card title={45} sub={70} right={<div className="row"><Seg n={2} w={72}/><Sk w={150} h={37} r={10}/><Btn w={113}/></div>}><T w="55%" lh={21} h={11}/></Card>
</>;

const Settings = () => <>
  <div className="settings-grid">{range(2).map(i => <section key={i} className="card hook">
    <div className="card-head"><div style={{display:'grid', flex:1}}><T w="40%" lh={24} h={15}/><T w="55%" lh={21} h={10}/></div><Sk w={38} h={22} r={11}/></div>
    <div className="hook-url"><T w={180} lh={20} h={12}/><Sk w={200} h={28} r={8}/></div>
    <div style={{display:'grid', gap:8, marginTop:16}}><T w={90} lh={18} h={9}/><div className="kind-list">{range(4).map(j => <T key={j} w={vary(j, 60, 90)} lh={22} h={11}/>)}</div></div>
  </section>)}</div>
  {range(3).map(i => <Card key={i} title={35} sub={55} right={i ? <Sk w={38} h={22} r={11}/> : <Seg n={3} w={58} h={30}/>}><T w="45%" lh={36} h={12}/></Card>)}
</>;

const Database = () => <>
  <section className="db-status sk-card"><Sk w={12} h={12} r={6}/><div style={{flex:1, display:'grid', gap:6}}><T w={60} lh={20} h={12}/><T w="75%" lh={18} h={10}/><T w="55%" lh={18} h={10}/></div><Btn w={84}/></section>
  <Kpis n={6} six/>
  <Card title={45} sub={65} right={<div className="row"><Btn w={98}/><Btn w={139}/></div>}><div style={{display:'grid', gap:14}}>{range(9).map(i => <div key={i} className="row" style={{justifyContent:'space-between'}}><T w={vary(i, 20, 35)} lh={20} h={10}/><T w={vary(i+1, 15, 30)} lh={20} h={11}/></div>)}</div></Card>
  <Card title={40} sub={80}><div className="db-actions">{range(3).map(i => <Sk key={i} h={91} r={12}/>)}</div></Card>
</>;

const Nodes = () => <>
  <Kpis n={6} six/>
  <Card title={30} sub={85} right={<div className="row"><T w={200} lh={22} h={11}/><Btn w={84}/></div>}><div className="nodes">{range(2).map(i => <article key={i} className="node">
    <div className="row" style={{gap:12}}><Sk w={10} h={10} r={5}/><div style={{flex:1, display:'grid'}}><T w="35%" lh={22} h={13}/><T w="50%" lh={18} h={9}/></div><Sk w={70} h={24} r={12}/></div>
    <T w="60%" lh={20} h={10} style={{marginTop:12}}/>
    <div style={{display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, margin:'12px 0'}}>{range(8).map(j => <div key={j} style={{display:'grid'}}><T w="60%" lh={16} h={8}/><T w="75%" lh={22} h={12}/></div>)}</div>
    <div className="row" style={{justifyContent:'flex-end'}}><Btn w={90}/><Btn w={90}/></div>
  </article>)}</div></Card>
</>;

const ThumbWall = () => <>
  <Card title={15} sub={20}><div className="tchips">{range(6).map(i => <Sk key={i} w={110 + (i * 29) % 50} h={32} r={16}/>)}</div></Card>
  <Toolbar><Seg n={3} w={100}/><Seg n={3} w={64} h={34}/><Seg n={4} w={44} h={34}/></Toolbar>
  <div className="thumb-wall">{range(12).map(i => <div key={i} className="twall"><Sk h="auto" r={12} style={{aspectRatio:'16/9'}}/><T w={vary(i, 70, 95)} lh={19} h={11}/><T w={vary(i+3, 40, 60)} lh={17} h={9}/></div>)}</div>
</>;

const PAGES = {thumbnails:ThumbWall, overview:Overview, insights:Insights, rankings:Rankings, report:Report, alerts:Alerts, planner:Planner, settings:Settings, database:Database, nodes:Nodes};

// `page` is the route: 'overview', 'ch:12', 'competitors:3', 'yt:UC…' …
export function PageSkeleton({page = 'overview'}) {
  const Page = PAGES[page] ?? (page.startsWith('competitors') ? Competitors : page.startsWith('ch:') || page.startsWith('yt:') ? Channel : Overview);
  return <div className="skeleton" aria-busy="true" aria-label="Loading"><Page page={page}/></div>;
}

// Placeholder rows for the sidebar's channel lists before the first load.
export function NavSkeleton({n, icon = 22}) {
  return range(n).map(i => <span key={i} className="nav-item sk-nav" aria-hidden="true"><Sk w={icon} h={icon} r={icon/2}/><T w={vary(i, 45, 75)} lh={20} h={11}/></span>);
}
