// Voice segmentation (simple energy VAD) and audio helpers.

export const SR = 16000;         // working sample rate
export const CHUNK_MS = 100;     // block size the worklet delivers
export const SILENCE_MS = 700;   // silence that closes a phrase
export const MAX_SEG_MS = 18000; // forced cut
// A fast speaker without real pauses would otherwise produce one giant paragraph
// that only appears (and gets translated) when they finally stop. Once a phrase
// is SOFT_CUT_MS long, a mere breath dip of SOFT_SILENCE_MS closes it, so long
// monologues stream out as readable 4-6 s pieces instead.
export const SOFT_CUT_MS = 3500;
export const SOFT_SILENCE_MS = 300;
export const MIN_SEG_MS = 900;   // discards noise and lone filler sounds
export const MIN_VOICED = 5;     // minimum voiced blocks (0.5 s of real speech)
export const PREROLL = 3;        // preceding blocks kept as preroll

export class Segmenter {
  constructor(speaker, onSegment, now = () => Date.now(), opts = {}) {
    this.speaker = speaker;
    this.onSegment = onSegment;
    this.now = now;
    this.minSegMs = opts.minSegMs ?? MIN_SEG_MS;
    this.minVoiced = opts.minVoiced ?? MIN_VOICED;
    this.floor = null;
    this.pre = [];
    this.chunks = [];
    this.voicedCount = 0;
    this.silence = 0;
    this.active = false;
    this.startedAt = 0;
  }

  push({ samples, rms }) {
    // Adaptive noise floor: only updated outside a phrase, so a long utterance
    // cannot raise the threshold until it cuts itself off.
    if (this.floor === null) this.floor = rms;
    else if (!this.active) {
      this.floor = rms < this.floor ? this.floor * 0.85 + rms * 0.15 : this.floor * 0.98 + rms * 0.02;
    }

    const threshold = Math.max(this.floor * 2.5, 0.008);
    const voiced = rms > threshold;

    if (!this.active) {
      this.pre.push(samples);
      if (this.pre.length > PREROLL) this.pre.shift();
      if (voiced) {
        this.active = true;
        this.chunks = this.pre.slice();
        this.pre = [];
        this.voicedCount = 1;
        this.silence = 0;
        this.startedAt = this.now() - this.chunks.length * CHUNK_MS;
      }
      return;
    }

    this.chunks.push(samples);
    if (voiced) { this.voicedCount++; this.silence = 0; }
    else this.silence += CHUNK_MS;

    const durationMs = this.chunks.length * CHUNK_MS;
    const softCut = durationMs >= SOFT_CUT_MS && this.silence >= SOFT_SILENCE_MS;
    if (this.silence >= SILENCE_MS) this.flush();
    else if (softCut || durationMs >= MAX_SEG_MS) this.flush(true);
  }

  // keepActive: a mid-utterance emission (soft or hard cut). The segmenter stays
  // inside the phrase, which keeps the adaptive floor frozen — a breath dip has
  // more energy than true ambient, and letting the floor adapt at every cut of a
  // long monologue ratchets the threshold up until quiet word onsets stop
  // crossing it. Only a real pause returns to idle.
  flush(keepActive = false) {
    if (!this.active) return;
    const durationMs = this.chunks.length * CHUNK_MS;
    const chunks = this.chunks;
    const startedAt = this.startedAt;
    const voiced = this.voicedCount;
    this.chunks = [];
    this.voicedCount = 0;
    if (keepActive) {
      // The next piece starts at the cut; the silence counter keeps running so
      // a dip that turns into a real pause still closes (the near-empty stub is
      // then discarded by the minimum-length rules).
      this.startedAt = this.now();
    } else {
      this.active = false;
      this.pre = [];
      this.silence = 0;
    }

    if (durationMs < this.minSegMs || voiced < this.minVoiced) return;

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const audio = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { audio.set(c, off); off += c.length; }
    this.onSegment({ speaker: this.speaker, audio, startedAt, durationMs });
  }
}

// Converts mono Float32 to 16-bit PCM WAV (for the Groq API).
export function floatToWav(samples, sampleRate = SR) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// Interjections and hesitation sounds: "Hmm", "Ooh", "ahh", "Mm"… They add nothing
// to the transcript and clutter the report.
const FILLERS = /^(h+m+|m+h*|u+h+|u+m+|a+h+|o+h+|o+u*h+|e+h+|e+r+|mhm|uh[- ]?huh|huh|hm+m*|aja|ajá)$/i;

export function isJunk(text) {
  const t = (text || '').trim();
  if (!t) return true;

  const junk = /^[\s.,!?¿¡"'\-–—]*(you|thank you\.?|thanks for watching[.!]?|bye[.!]?|\[.*\]|\(.*\))?[\s.,!?"'.]*$/i;
  if (junk.test(t)) return true;

  // A single "word" that is nothing but a hesitation sound.
  const bare = t.replace(/[\s.,!?¿¡"'\-–—…]/g, '');
  if (!bare) return true;
  if (bare.length <= 2 && !/^(no|ok|hi|so|i|a|do|go|up|we|he|it)$/i.test(bare)) return true;
  return FILLERS.test(bare);
}
