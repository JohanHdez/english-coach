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
