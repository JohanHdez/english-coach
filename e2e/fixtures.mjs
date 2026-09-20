// Builds the spoken fixtures the end-to-end runs feed into Chrome's fake microphone.
//
// Sentences are synthesised with the macOS voices (`say`), converted with
// `afconvert`, and laid on a timeline with known silences, so every run knows to
// the millisecond when each sentence starts and can measure how long the
// extension took to show it. Nothing here is recorded speech: no voice ever
// leaves this machine and the files are regenerated on demand.
//
// Usage: node e2e/fixtures.mjs   → writes e2e/fixtures/<name>.wav + <name>.json

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, 'fixtures');
const RATE = 48000;

// Chrome's fake capture device reads a WAV once per opened stream. The
// `%noloop` suffix on the flag stops it from looping when the file ends.
export const SENTENCES = {
  en1: { voice: 'Samantha', lang: 'en', text: 'Thanks for joining. Before we start, can you walk me through how the payment migration went last quarter?' },
  es1: { voice: 'Paulina', lang: 'es', text: 'Claro, con gusto. Migramos la plataforma de pagos en tres meses y el tiempo de carga bajó de cuatro segundos a poco más de uno.' },
  en2: { voice: 'Daniel', lang: 'en', text: 'That is impressive. What was the hardest part of the rollout for your team?' },
  es2: { voice: 'Mónica', lang: 'es', text: 'Lo más difícil fue coordinar los equipos de Canadá y Colombia con horarios distintos.' },
  en3: { voice: 'Samantha', lang: 'en', text: 'Great, let us move on to the next topic. How do you usually handle disagreements about priorities?' },
  es3: { voice: 'Paulina', lang: 'es', text: 'Normalmente escucho primero a cada persona y después propongo un orden con los datos que tenemos.' },
  // One breath, no punctuation: the synthesiser leaves no dip long enough for a
  // soft cut, so only the forced cut can split it.
  en_long: { voice: 'Samantha', lang: 'en', text: 'and then we moved the whole payment platform over to the new framework while keeping every single existing integration alive which meant the team had to rewrite the checkout flow and the refund flow and the reporting jobs at the same time without ever taking the service down for the customers who were paying us every minute of every day' },
};

// name → [ silenceSeconds | sentenceKey, ... ]
export const TIMELINES = {
  // One speaker, one language: the latency baseline.
  english: [1.0, 'en1', 1.5, 'en2', 1.5, 'en3', 2.0],
  // Alternating languages, each in its own sentence with a real pause between.
  bilingual: [1.0, 'en1', 1.5, 'es1', 1.5, 'en2', 1.5, 'es2', 1.5, 'en3', 1.5, 'es3', 2.0],
  // A speaker who never pauses: how soon the first words of a monologue land.
  monologue: [1.0, 'en_long', 2.0],
};

function synth(key) {
  const { voice, text } = SENTENCES[key];
  const aiff = join(FIXTURES, `${key}.aiff`);
  const wav = join(FIXTURES, `${key}.wav`);
  if (!existsSync(wav)) {
    execFileSync('say', ['-v', voice, '-o', aiff, text]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1', aiff, wav]);
  }
  return readPcm(wav);
}

// Minimal RIFF reader: mono 16-bit PCM only, which is what afconvert wrote above.
function readPcm(path) {
  const buf = readFileSync(path);
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${path}: not a PCM WAV`);
  if (fmt.channels !== 1 || fmt.rate !== RATE || fmt.bits !== 16) {
    throw new Error(`${path}: expected mono 16-bit ${RATE} Hz, got ${JSON.stringify(fmt)}`);
  }
  return new Int16Array(data.buffer, data.byteOffset, data.length / 2);
}

function writeWav(path, samples) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length * 2, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2)]));
}

export function build(name) {
  mkdirSync(FIXTURES, { recursive: true });
  const parts = [];
  const cues = [];
  let at = 0;
  for (const step of TIMELINES[name]) {
    if (typeof step === 'number') {
      parts.push(new Int16Array(Math.round(step * RATE)));
      at += step;
      continue;
    }
    const pcm = synth(step);
    const dur = pcm.length / RATE;
    cues.push({ key: step, lang: SENTENCES[step].lang, text: SENTENCES[step].text, start: round(at), end: round(at + dur) });
    parts.push(pcm);
    at += dur;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  const wav = join(FIXTURES, `${name}.wav`);
  writeWav(wav, out);
  const manifest = { name, rate: RATE, duration: round(at), cues };
  writeFileSync(join(FIXTURES, `${name}.json`), JSON.stringify(manifest, null, 2) + '\n');
  return { wav, manifest };
}

const round = (s) => Math.round(s * 1000) / 1000;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const name of Object.keys(TIMELINES)) {
    const { wav, manifest } = build(name);
    console.log(`${wav}  ${manifest.duration}s`);
    for (const c of manifest.cues) console.log(`  ${c.start.toFixed(2).padStart(6)}–${c.end.toFixed(2).padEnd(6)} ${c.lang}  ${c.text.slice(0, 60)}…`);
  }
}
