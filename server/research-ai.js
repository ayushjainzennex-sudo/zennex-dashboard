// Topic research: an AI brief from Gemini, built on the research data (scorecard + title patterns), so the model
// reasons from real numbers instead of guessing. Needs GEMINI_API_KEY in .env (optional GEMINI_MODEL).
// The key is only ever sent in a request header to Google. Part of topic-research: see RESEARCH.md.
import {score, angles, clean} from './research.js';

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.8-flash';
// Tried in order when a model is busy (503/429) or too slow. Google's newest models are often overloaded.
const CHAIN = () => [...new Set([MODEL(), ...(process.env.GEMINI_FALLBACK_MODEL || 'gemini-3-flash-preview,gemini-3.1-flash-lite').split(',').map(m => m.trim()).filter(Boolean)])];
const cache = new Map();

async function call(model, prompt, key, ms) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: {'content-type': 'application/json', 'x-goog-api-key': key}, signal: AbortSignal.timeout(ms),
    body: JSON.stringify({contents: [{role: 'user', parts: [{text: prompt}]}], generationConfig: {responseMimeType: 'application/json', temperature: .8, thinkingConfig: {thinkingLevel: process.env.GEMINI_THINKING || 'low'}}}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error('Gemini: ' + (d.error?.message ?? 'HTTP ' + r.status)), {status: r.status === 429 ? 429 : 502, busy: [429, 500, 503].includes(r.status)});
  const text = d.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
  try { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); }
  catch { throw Object.assign(new Error('Gemini sent an answer that could not be read. Try again.'), {status: 502, busy: true}); }
}
// The main model gets 35 s, the others 50 s; a busy or slow one passes the job to the next. Returns {out, model}.
export async function gemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw Object.assign(new Error('AI brief is off: add GEMINI_API_KEY to this node’s .env.'), {status: 503});
  let last;
  for (const model of CHAIN()) {
    try { return {out: await call(model, prompt, key, model === MODEL() ? 35000 : 50000), model}; }
    catch (err) { last = err; if (!(err.busy || err.name === 'TimeoutError')) throw err; }
  }
  throw Object.assign(new Error(last?.name === 'TimeoutError' ? 'Gemini is too slow right now. Try again in a few minutes.' : last.message), {status: 503});
}

const LANG = {english: 'English', hinglish: 'Hinglish (Hindi written in Roman letters, mixed with English, the way Indian tech YouTubers title videos)', hindi: 'Hindi (Devanagari)'};

export async function brief(q, geo = 'IN', {lang = 'english', fresh = false, coverage = []} = {}) {
  q = clean(q);
  if (!q) throw Object.assign(new Error('Enter a topic.'), {status: 400});
  lang = LANG[lang] ? lang : 'english';
  const key = [q, geo, lang].join('|'), hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 24 * 36e5) return hit.data;

  const [card, ang] = await Promise.all([score(q, geo), angles(q, geo).catch(() => null)]);
  const facts = {
    topic: q, country: 'India',
    score: card.total, verdict: card.verdict, parts: card.parts.map(p => `${p.label}: ${p.value}/100 (${p.note})`),
    rising_searches: card.related.rising.slice(0, 10).map(r => `${r.query} ${r.value}`),
    top_ranking_videos: card.results.slice(0, 12).map(v => `"${v.title}" by ${v.channel}, ${v.views ?? '?'} views, ${v.age ?? 'age unknown'}`),
    title_patterns: ang?.patterns.map(p => `${p.label}: ${p.count} videos${p.lift ? `, ${p.lift.toFixed(1)}x median views` : ''}`) ?? [],
    title_style: ang?.style ?? null, viewer_questions: ang?.questions.slice(0, 12) ?? [],
    already_made_by_us_or_competitors: coverage.slice(0, 8).map(v => `"${v.title}" (${v.kind === 'own' ? 'our channel ' : 'competitor '}${v.name}, ${v.views} views)`),
  };
  const prompt = `You are a YouTube content strategist for an Indian tech channel (laptops, phones, gadgets, buying guides).
Using ONLY the research data below (real YouTube search results and Google Trends for India), write a brief for a new video on this topic.
Be specific and practical. Do not invent statistics; refer to the data when you justify something.
Write video titles, hooks, Shorts ideas and thumbnail text in ${LANG[lang]}. Write everything else in plain English.

Research data (JSON):
${JSON.stringify(facts, null, 1)}

Answer with JSON only, in exactly this shape:
{
 "summary": "2-3 sentences: is this worth making now and why, based on the data",
 "best_angle": "the single angle you'd pick, in one sentence",
 "gap": "what the current top videos miss or get wrong, in one or two sentences",
 "titles": [{"title": "...", "why": "short reason"}],             // 6 titles, under 70 characters, no clickbait lies
 "angles": [{"angle": "...", "why": "..."}],                      // 4 different angles
 "hook": "first 15 seconds of the video, spoken",
 "outline": ["section 1", "section 2", "..."],                    // 5-8 sections
 "shorts": ["..."],                                                // 4 Shorts ideas
 "thumbnail_text": ["..."],                                        // 4 options, max 4 words each
 "risks": ["..."]                                                  // 2-3 things that could make it underperform
}`;
  const {out, model} = await gemini(prompt);
  const data = {q, geo, lang, model, fetched: new Date().toISOString(), score: card.total, ...out};
  cache.set(key, {at: Date.now(), data});
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return data;
}
