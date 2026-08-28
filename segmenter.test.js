import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Segmenter, isJunk, floatToWav, foldIntoTranscript,
  CHUNK_MS, SILENCE_MS, MAX_SEG_MS, SOFT_CUT_MS, SOFT_SILENCE_MS, MIN_VOICED,
  MERGE_GAP_MS, MERGE_MAX_CHARS, PREVIEW_EVERY_MS, PREVIEW_MIN_MS,
} from './segmenter.js';

const VOICE = 0.5;
const QUIET = 0.001;
const block = (amp) => ({ samples: new Float32Array(1600).fill(amp), rms: amp });

// Runs a [amplitude, blocks] pattern through a Segmenter, with ambient noise
// first so the adaptive floor settles the way it does in a real capture.
function run(pattern) {
  const out = [];
  let t = 0;
  const seg = new Segmenter('them', (s) => out.push(s), () => t);
  for (let i = 0; i < 10; i++) { t += CHUNK_MS; seg.push(block(QUIET)); }
  for (const [amp, n] of pattern) {
    for (let i = 0; i < n; i++) { t += CHUNK_MS; seg.push(block(amp)); }
  }
  seg.flush();
  return out;
}

test('a monologue with only breath dips streams out as short pieces', () => {
  const pattern = [];
  for (let i = 0; i < 6; i++) pattern.push([VOICE, 45], [QUIET, SOFT_SILENCE_MS / CHUNK_MS]);
  const segs = run(pattern);
  assert.ok(segs.length >= 5, `expected a stream of pieces, got ${segs.length}`);
  for (const s of segs) {
    assert.ok(s.durationMs < MAX_SEG_MS, 'no piece should need the hard cut');
    assert.ok(s.durationMs >= SOFT_CUT_MS, `piece of ${s.durationMs}ms is below the soft-cut floor`);
  }
});

test('pieces of a monologue keep ascending timestamps', () => {
  const pattern = [];
  for (let i = 0; i < 4; i++) pattern.push([VOICE, 45], [QUIET, 3]);
  const segs = run(pattern);
  for (let i = 1; i < segs.length; i++) {
    assert.ok(segs[i].startedAt > segs[i - 1].startedAt, 'chunks must sort correctly against the other speaker');
  }
});

test('a normal short phrase with a real pause stays one segment', () => {
  const segs = run([[VOICE, 20], [QUIET, SILENCE_MS / CHUNK_MS + 1]]);
  assert.equal(segs.length, 1);
});

test('a breath dip before SOFT_CUT_MS does not cut', () => {
  const segs = run([[VOICE, 10], [QUIET, 3], [VOICE, 10], [QUIET, 8]]);
  assert.equal(segs.length, 1, 'the dip at 1s must be swallowed into the phrase');
});

test('speech with no dips at all still hits the hard cut', () => {
  const segs = run([[VOICE, 200], [QUIET, 8]]);
  assert.equal(segs[0].durationMs, MAX_SEG_MS);
  assert.equal(segs.length, 2);
});

test('the noise floor stays frozen across soft cuts of one monologue', () => {
  // Breath dips carry more energy than true ambient. If a soft cut returned the
  // segmenter to idle, the floor would adapt toward the dips and ratchet the
  // threshold up until quiet word onsets stopped crossing it.
  const AMBIENT = 0.004;
  // Above ambient, below the activation threshold (max(floor*2.5, 0.008)): a dip
  // louder than that reads as speech and rightly never cuts anything.
  const DIP = 0.0079;
  const out = [];
  let t = 0;
  const seg = new Segmenter('them', (s) => out.push(s), () => t);
  for (let i = 0; i < 20; i++) { t += CHUNK_MS; seg.push(block(AMBIENT)); }
  const round = () => {
    for (let i = 0; i < 40; i++) { t += CHUNK_MS; seg.push(block(VOICE)); }
    for (let i = 0; i < 4; i++) { t += CHUNK_MS; seg.push(block(DIP)); }
  };
  // The floor legitimately absorbs one block at utterance start (pre-existing,
  // once per utterance). The invariant under test is that it does not keep
  // ratcheting across the soft cuts inside the monologue.
  round();
  const afterFirstCut = seg.floor;
  for (let r = 0; r < 11; r++) round();
  assert.equal(seg.floor, afterFirstCut,
    `floor ratcheted from ${afterFirstCut.toFixed(5)} to ${seg.floor.toFixed(5)} across soft cuts`);
  assert.ok(out.length >= 10, `monologue should keep streaming pieces, got ${out.length}`);
});

test('a soft-cut dip that becomes a real pause leaves no phantom segment', () => {
  // The stub accumulated after a mid-utterance cut, if the dip just continues
  // into a real pause, must be discarded by the minimum-length rules.
  const segs = run([[VOICE, 40], [QUIET, 12]]);
  assert.equal(segs.length, 1);
  assert.ok(segs[0].durationMs >= SOFT_CUT_MS);
});

test('short noises are still discarded', () => {
  const segs = run([[VOICE, MIN_VOICED - 2], [QUIET, 8]]);
  assert.equal(segs.length, 0);
});

test('flush leaves no state behind for the next phrase', () => {
  const out = [];
  let t = 0;
  const seg = new Segmenter('them', (s) => out.push(s), () => t);
  for (let i = 0; i < 10; i++) { t += CHUNK_MS; seg.push(block(QUIET)); }
  for (let i = 0; i < 20; i++) { t += CHUNK_MS; seg.push(block(VOICE)); }
  seg.flush();
  const firstLen = out[0].audio.length;
  for (let i = 0; i < 20; i++) { t += CHUNK_MS; seg.push(block(VOICE)); }
  seg.flush();
  assert.equal(out.length, 2);
  assert.ok(out[1].audio.length <= firstLen + 3 * 1600, 'second phrase must not inherit the first one\'s chunks');
});

test('isJunk drops lone hesitations and keeps real short answers', () => {
  for (const junk of ['Hmm.', 'Ooh.', 'uh', 'Uh-huh', 'er', '']) assert.ok(isJunk(junk), junk);
  for (const real of ['Okay.', 'No.', 'Yeah, sure.', 'I do.']) assert.ok(!isJunk(real), real);
});

test('floatToWav produces a valid 16 kHz mono PCM16 header', async () => {
  const wav = floatToWav(new Float32Array(1600).fill(0.5));
  const view = new DataView(await wav.arrayBuffer());
  assert.equal(view.getUint32(24, true), 16000);       // sample rate
  assert.equal(view.getUint16(22, true), 1);           // mono
  assert.equal(view.getUint32(40, true), 1600 * 2);    // data length
});

test('same-speaker entries within the merge gap fold into one turn', () => {
  const tr = [{ speaker: 'me', text: 'I think I need more', t: 1000, dur: 2 }];
  const shown = foldIntoTranscript(tr, { speaker: 'me', text: 'fluency in English.', t: 4500, dur: 1.5 });
  assert.equal(tr.length, 1);
  assert.equal(tr[0].text, 'I think I need more fluency in English.');
  assert.equal(shown, tr[0]);
  assert.equal(tr[0].dur, 5);
});

test('a different speaker or a long silence starts a new turn', () => {
  const tr = [{ speaker: 'me', text: 'Hello.', t: 0, dur: 1 }];
  foldIntoTranscript(tr, { speaker: 'them', text: 'Hi.', t: 1500, dur: 1 });
  assert.equal(tr.length, 2);
  foldIntoTranscript(tr, { speaker: 'them', text: 'A later thought.', t: 2500 + MERGE_GAP_MS + 1000, dur: 1 });
  assert.equal(tr.length, 3);
});

test('a merged turn stops growing at the character cap', () => {
  const tr = [{ speaker: 'them', text: 'x'.repeat(MERGE_MAX_CHARS), t: 0, dur: 5 }];
  foldIntoTranscript(tr, { speaker: 'them', text: 'more', t: 5500, dur: 1 });
  assert.equal(tr.length, 2);
});

test('folding compares against the chronologically latest turn, not the last appended', () => {
  // The transcription queue lets 'them' overtake 'me', so an older 'me' segment
  // can be appended after a newer 'them' one.
  const tr = [
    { speaker: 'them', text: 'Question?', t: 10000, dur: 2 },
    { speaker: 'me', text: 'Earlier words', t: 5000, dur: 1 },
  ];
  foldIntoTranscript(tr, { speaker: 'me', text: 'arriving late', t: 6500, dur: 1 });
  assert.equal(tr.length, 3);
});

// ------------------------------------------------------------------ previews

// Like run(), but keeps the phrase open: the preview lane is about what the
// segmenter emits *before* anything closes.
function runWithPreview(pattern, opts = {}) {
  const segs = [];
  const previews = [];
  let t = 0;
  const seg = new Segmenter('them', (s) => segs.push(s), () => t, {
    onPreview: (p) => previews.push(p),
    ...opts,
  });
  for (let i = 0; i < 10; i++) { t += CHUNK_MS; seg.push(block(QUIET)); }
  for (const [amp, n] of pattern) {
    for (let i = 0; i < n; i++) { t += CHUNK_MS; seg.push(block(amp)); }
  }
  return { seg, segs, previews };
}

test('an open phrase previews itself while it is still growing', () => {
  const { segs, previews } = runWithPreview([[VOICE, 40]]);
  assert.equal(segs.length, 0, 'nothing has closed the phrase yet');
  assert.deepEqual(previews.map((p) => p.durationMs), [1200, 2400, 3600]);
});

test('a preview carries the audio captured so far, tagged with its speaker', () => {
  const { previews } = runWithPreview([[VOICE, 40]]);
  assert.ok(previews.length > 0, 'the phrase must have been previewed at all');
  for (const p of previews) {
    assert.equal(p.speaker, 'them');
    assert.equal(p.audio.length, (p.durationMs / CHUNK_MS) * 1600);
  }
});

test('speech shorter than PREVIEW_MIN_MS is never previewed', () => {
  const short = PREVIEW_MIN_MS / CHUNK_MS - 4;
  assert.equal(runWithPreview([[VOICE, short], [QUIET, 8]]).previews.length, 0);
  // Positive control: the same shape, long enough, does preview.
  assert.ok(runWithPreview([[VOICE, short + 8], [QUIET, 8]]).previews.length > 0);
});

test('silence alone is never previewed', () => {
  const { previews } = runWithPreview([[QUIET, 60]]);
  assert.equal(previews.length, 0);
});

test('previews are spaced by PREVIEW_EVERY_MS', () => {
  const { previews } = runWithPreview([[VOICE, 100]]);
  assert.ok(previews.length >= 3, `expected several previews, got ${previews.length}`);
  for (let i = 1; i < previews.length; i++) {
    assert.equal(previews[i].durationMs - previews[i - 1].durationMs, PREVIEW_EVERY_MS);
  }
});

test('a preview never steals audio from the real segment', () => {
  const { seg, segs, previews } = runWithPreview([[VOICE, 40]]);
  seg.flush();
  assert.ok(previews.length > 0, 'the phrase must have been previewed at all');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].audio.length, 42 * 1600, 'the closed segment keeps every chunk');
});

test('the push that cuts the phrase emits the segment, not another preview', () => {
  // The authoritative text lands on that same push; a provisional copy of the
  // very same audio would only flicker on screen before being replaced.
  const { segs, previews } = runWithPreview([[VOICE, 40], [QUIET, 3]], { previewEveryMs: CHUNK_MS });
  assert.equal(segs.length, 1);
  assert.ok(previews.length > 0, 'with no throttle every push before the cut previews');
  assert.ok(!previews.some((p) => p.durationMs === segs[0].durationMs),
    'a preview duplicated the audio of the segment that just closed');
});

test('each piece of a monologue previews on its own', () => {
  const pattern = [];
  for (let i = 0; i < 3; i++) pattern.push([VOICE, 45], [QUIET, 3]);
  const { segs, previews } = runWithPreview(pattern);
  assert.ok(segs.length >= 2, `expected a stream of pieces, got ${segs.length}`);
  assert.ok(previews.some((p, i) => i > 0 && p.durationMs < previews[i - 1].durationMs),
    'the preview clock must restart at each soft cut instead of growing across pieces');
});

test('without an onPreview callback the segmenter behaves exactly as before', () => {
  const withOut = run([[VOICE, 40], [QUIET, 12]]);
  assert.equal(withOut.length, 1);
});
