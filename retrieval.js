// Literal retrieval over the transcript. Free, deterministic, and incapable of
// inventing anything: what it returns is what was actually said. Pure — it runs
// unmodified in Node.

import { normalizeText } from './memory.js';

export const MIN_CONTENT_TERMS = 2;
export const SCORE_FLOOR = 0.35;
export const EVIDENCE_TURNS = 3;
export const QUERY_MAX_CHARS = 400;

const STOP = new Set((
  'and are but for from have has had her his its not the that this was were will with you your '
  + 'about into over than then they them their there what when where which who why how would could '
  + 'can did does done just like some more most only very much any our out '
  + 'con como para pero por que del las los una unos unas est esta este esto eso ese esa '
  + 'son fue eran ser sido tiene tienen hacer hace muy mas cuando donde porque quien cual '
  + 'nos sus mi tu su ya lo le les se sobre entre desde hasta'
).split(/\s+/));

export function tokenize(text) {
  return normalizeText(text).split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
}

// IDF over the conversation's own turns: names and jargon outweigh filler, which
// is exactly the signal that tells "they are asking about X" from "they are
// asking something".
export function buildIndex(turns) {
  const df = new Map();
  for (const t of turns) for (const w of new Set(tokenize(t.text))) df.set(w, (df.get(w) || 0) + 1);
  const N = turns.length || 1;
  const idf = new Map();
  for (const [w, n] of df) idf.set(w, Math.log(1 + N / (1 + n)));
  return { idf, N, floor: Math.log(1 + N) };
}

// Soft cuts split one question into several segments, so the query is the whole
// trailing run of the other speaker, not the last entry.
export function queryFrom(turns) {
  const sorted = [...turns].sort((a, b) => a.t - b.t);
  const run = [];
  for (let i = sorted.length - 1; i >= 0 && sorted[i].speaker === 'them'; i--) run.unshift(sorted[i]);
  const text = run.map((t) => t.text).join(' ');
  return text.length > QUERY_MAX_CHARS ? text.slice(-QUERY_MAX_CHARS) : text;
}

// Normalised to [0,1]: the share of the question's own IDF mass a turn accounts
// for. Comparable across questions, so one threshold works for all of them.
export function scoreTurns(corpus, query, index) {
  const terms = [...new Set(tokenize(query))];
  const weight = (w) => index.idf.get(w) ?? index.floor;
  const mass = terms.reduce((n, w) => n + weight(w), 0);
  const scored = corpus.map((turn) => {
    const words = new Set(tokenize(turn.text));
    const hit = terms.filter((w) => words.has(w)).reduce((n, w) => n + weight(w), 0);
    return { turn, score: mass ? hit / mass : 0 };
  });
  scored.sort((a, b) => b.score - a.score);
  return { terms, scored };
}
