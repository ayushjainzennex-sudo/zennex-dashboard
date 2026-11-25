// A tiny route table for the API: [METHOD, '/api/path/:param', handler]. A parameter can carry its own
// pattern, e.g. ':id(\\d+)'; without one it matches a single path segment. METHOD '*' matches any method.
export function compile(routes) {
  return routes.map(([method, path, handler]) => {
    const keys = [];
    const source = path.replace(/:(\w+)(?:\(((?:[^()]|\([^()]*\))+)\))?/g, (_, key, pattern) => { keys.push(key); return '(' + (pattern ?? '[^/]+') + ')'; });
    return {method, path, re: new RegExp('^' + source + '$'), keys, handler};
  });
}

// -> {handler, params} | {status: 405} (the path exists with another method) | null (unknown path)
export function match(table, method, pathname) {
  let otherMethod = false;
  for (const r of table) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    if (r.method !== '*' && r.method !== method) { otherMethod = true; continue; }
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return {handler: r.handler, params};
  }
  return otherMethod ? {status: 405} : null;
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
// A handler returns the JSON body for a 200, or reply(status, body) for anything else.
export const reply = (status, body) => ({[REPLY]: true, status, body});
export const REPLY = Symbol('reply');

// Reads a JSON object body (max 200 kB). Bad JSON or a non-object body is a 400, not a server error.
export async function readJson(request, limit = 2e5) {
  let body = '';
  for await (const chunk of request) { body += chunk; if (body.length > limit) throw new HttpError(413, 'Request too large.'); }
  if (!body) return {};
  let data;
  try { data = JSON.parse(body); } catch { throw new HttpError(400, 'The request body is not valid JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'The request body must be a JSON object.');
  return data;
}
