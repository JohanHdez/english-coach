// Session memory: what the coach remembers about a conversation that is longer
// than any single prompt. Pure — no chrome.*, `now` injected — so it runs in Node.

export const CHUNK_BAND = [0.8, 1.2];
export const OVERLAP_CHARS = 400;
export const CHUNK_MAX_FACTOR = 1.5;
export const REPLY_TAIL_FACTOR = 1.5;
export const DISTILL_COOLDOWN_MS = 45000;
export const BUDGET_WINDOW_MS = 60000;
export const BUDGET_SAFETY = 0.75;
export const WRONG_MAX_CHARS = 60;
export const MIN_QUOTE_CHARS = 12;
export const RECURRENCE_MIN = 2;

export const NOMINAL_COST = { hints: 1400, starter: 900, reply: 3400, report: 6000, distill: 1300 };
export const CAPS = { topics: 60, open: 12, errors: 40, lakeEntries: 200, samples: 3, vetoed: 200 };

// A rate-limited provider gets small chunks so a round fits in whatever the live
// hints leave of the minute; an unmetered one gets bigger ones, which distil better.
export function sizing(tpm) {
  const chunkChars = tpm ? 1800 : 4000;
  return { chunkChars, tailChars: chunkChars * REPLY_TAIL_FACTOR };
}

export function emptyMemory(sessionId) {
  return {
    sessionId, coveredUntil: 0, carry: '', merged: false,
    topics: [], open: [], errors: [],
    rounds: 0, skipped: 0, rejected: 0,
  };
}

// The transcript can be cleared from the side panel while the offscreen document
// is still holding a memory of it. An orphaned memory would narrate a
// conversation that no longer exists, so it resets itself on read.
export function reconcile(memory, turns) {
  if (!memory) return emptyMemory(null);
  const newest = turns.reduce((n, t) => (t.t > n ? t.t : n), 0);
  if (memory.coveredUntil > newest) return emptyMemory(memory.sessionId);
  return memory;
}

export const linesOf = (turns) =>
  turns.map((t) => `${t.speaker === 'me' ? 'LEARNER' : 'OTHER'}: ${t.text}`).join('\n');

const byTime = (turns) => [...turns].sort((a, b) => a.t - b.t);
const endOf = (t) => t.t + (t.dur || 0) * 1000;

// The VAD cuts audio on silence; this cuts text the same way. Inside the band
// around the target size, the chunk ends at the largest pause between turns, so
// an idea is far less likely to be split across two distillation rounds.
export function selectChunk(turns, memory, chunkChars, { all = false } = {}) {
  const sorted = byTime(turns);
  if (!sorted.length) return null;

  // foldIntoTranscript can only ever extend the turn with the highest `t`.
  // Distilling it would lose whatever is appended to it afterwards — silently.
  // The exception is the final flush: by then the segmenters are flushed and the
  // queue is drained, so nothing can grow and the last turn must be included.
  const newest = sorted[sorted.length - 1].t;
  const covered = memory?.coveredUntil || 0;
  const pending = sorted.filter((t) => t.t > covered && (all || t.t < newest));
  if (!pending.length) return null;

  const size = (t) => t.text.length + 1;
  const total = pending.reduce((n, t) => n + size(t), 0);
  if (!all && total < chunkChars) return null;

  if (all) {
    const overlapAll = linesOf(sorted.filter((t) => t.t <= covered)).slice(-OVERLAP_CHARS);
    const textAll = linesOf(pending);
    return {
      turns: pending, text: textAll,
      overlapTurns: sorted.filter((t) => t.t <= covered), overlap: overlapAll,
      endsAt: pending[pending.length - 1].t, chars: textAll.length,
    };
  }

  const lo = chunkChars * CHUNK_BAND[0];
  const hi = Math.min(chunkChars * CHUNK_BAND[1], chunkChars * CHUNK_MAX_FACTOR);

  let acc = 0;
  let cut = -1;
  let bestGap = -1;
  for (let i = 0; i < pending.length; i++) {
    acc += size(pending[i]);
    if (acc < lo) continue;
    const next = pending[i + 1];
    const gap = next ? Math.max(0, next.t - endOf(pending[i])) : 0;
    const bonus = next && next.speaker !== pending[i].speaker ? 1 : 0;
    if (cut === -1 || gap + bonus > bestGap) { bestGap = gap + bonus; cut = i; }
    if (acc >= hi) break;
  }
  // A single turn longer than the ceiling: taken whole. Turns are atomic because
  // splitting one would break the LEARNER-line attribution guard.
  if (cut === -1) cut = 0;

  const chunk = pending.slice(0, cut + 1);
  const overlapTurns = sorted.filter((t) => t.t <= covered);
  const overlap = linesOf(overlapTurns).slice(-OVERLAP_CHARS);
  const text = linesOf(chunk);
  return { turns: chunk, text, overlapTurns, overlap, endsAt: chunk[chunk.length - 1].t, chars: text.length };
}
