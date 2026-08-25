import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Segmenter, isJunk, floatToWav,
  CHUNK_MS, SILENCE_MS, MAX_SEG_MS, SOFT_CUT_MS, SOFT_SILENCE_MS, MIN_VOICED,
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
