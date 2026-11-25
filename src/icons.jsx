// A small set of outline icons (24×24 grid, 1.75 stroke, drawn in currentColor), used instead of text symbols
// so every icon has the same weight and size.
import React from 'react';

const PATHS = {
  overview: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></>,
  insights: <><path d="M4 20V4"/><path d="M4 20h16"/><path d="m8 15 3.5-4 3 2.5L20 7"/></>,
  rankings: <><path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="M4.5 5 5.5 4.5V8"/><path d="M4 11.5c.3-.6.9-1 1.5-1s1.2.5 1.2 1.1c0 .9-2.7 1.9-2.7 3.4h2.8"/></>,
  report: <><path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4.5"/><path d="M9 13h6"/><path d="M9 16.5h4"/></>,
  alerts: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></>,
  flag: <><path d="M5.5 21V4"/><path d="M5.5 4.5h11l-2 4 2 4h-11"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/></>,
  database: <><ellipse cx="12" cy="6" rx="7" ry="2.8"/><path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6"/><path d="M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8"/></>,
  nodes: <><rect x="3.5" y="4" width="17" height="6.5" rx="1.5"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="1.5"/><path d="M7 7.25h.01M7 16.75h.01"/></>,
  planner: <><rect x="3.5" y="5" width="17" height="15.5" rx="1.5"/><path d="M3.5 10h17"/><path d="M8 3v4M16 3v4"/></>,
  search: <><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></>,
  moon: <path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 14.3 4.3L20 15.5"/><path d="M20 20v-4.5h-4.5"/></>
};

export function Icon({name, size = 16, className = 'icon', ...rest}) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>{PATHS[name]}</svg>;
}

// The brand mark: a play triangle with softened corners.
export const Logo = () => <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.8v14.4c0 1 1.1 1.6 1.9 1.1l11.1-7.2c.8-.5.8-1.7 0-2.2L8.9 3.7C8.1 3.2 7 3.8 7 4.8z" fill="currentColor"/></svg>;
