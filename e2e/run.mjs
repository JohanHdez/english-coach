// End-to-end run: real Chrome, the unpacked extension, a synthesised fixture
// through the fake microphone. Prints one row per sentence with the latency of
// the live line and of the bubble, and what the bubble said.
//
//   node e2e/run.mjs english               # one speaker, English, local engine
//   node e2e/run.mjs bilingual             # alternating English and Spanish
//   node e2e/run.mjs bilingual --lang=es   # multilingual model, Spanish session
//   node e2e/run.mjs english --engine=api  # Groq stand-in on localhost (no key, no audio leaves)
//   node e2e/run.mjs english --engine=api --real   # the real Groq: GROQ_API_KEY in the environment
//   node e2e/run.mjs english --lanes=2     # same audio on both lanes (queue stress)
//   flags: --headless  --device=wasm  --model=<hf id>  --delay=<mock ms>  --json
//
// The first run downloads the Whisper model into e2e/.profile; later runs reuse it.

import { Session, settingsFor, analyse, saveResult } from './harness.mjs';
import { startMockGroq } from './mock-groq.mjs';
import { build } from './fixtures.mjs';

const args = process.argv.slice(2);
const fixture = args.find((a) => !a.startsWith('--')) || 'english';
const flag = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : (args.includes(`--${name}`) ? true : def);
};

const engine = flag('engine', 'local');
const real = flag('real', false) === true;
let groqKey = '';
let mock = null;
if (engine === 'api' && real) {
  groqKey = process.env.GROQ_API_KEY || '';
  if (!groqKey) {
    console.error('GROQ_API_KEY is not set; --real needs it (it is written only into e2e/.profile).');
    process.exit(2);
  }
} else if (engine === 'api') {
  mock = await startMockGroq({ manifest: build(fixture).manifest, delayMs: Number(flag('delay', 900)) });
  groqKey = 'e2e-mock';
}

const settings = settingsFor({
  engine,
  groqKey,
  lanes: Number(flag('lanes', 1)),
  lang: flag('lang', 'en'),
  model: flag('model', undefined),
  device: flag('device', 'webgpu'),
});
if (mock) settings.groqBase = mock.url;
const log = (s) => console.error(s);

const session = await Session.open({ fixture, headless: flag('headless', false) === true, settings, log });
let result;
try {
  log('warming up the engine…');
  await session.warmUp(log);
  if (mock) mock.reset();
  log(`engine ready on ${session.device}; recording ${fixture} (${session.manifest.duration}s)…`);
  result = await session.record(log, { onStart: (t0) => { if (mock) mock.setT0(t0); } });
} finally {
  await session.close();
  if (mock) await mock.close();
}

const report = analyse(result, session.manifest);
if (mock) report.groq = mock.requests.map((r) => ({ ...r, at: r.at - result.t0 }));
const file = saveResult(`${fixture}-${engine}${mock ? '-mock' : ''}`, { fixture, settings: { ...settings, groqKey: settings.groqKey ? '<set>' : '' }, device: session.device, ...result, report });

if (flag('json', false) === true) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const ms = (v) => (v === null ? '   —  ' : `${String(v).padStart(5)}ms`);
  console.log(`\n${fixture} · engine ${engine}${mock ? ' (mock, ' + flag('delay', 900) + 'ms)' : ''} · model on ${session.device} · previews ${report.previews} · max queue ${report.maxPending}`);
  console.log('sentence  lang  live after onset  live match  bubble after end  last piece  pieces  match  bubble lang  text');
  for (const r of report.rows) {
    console.log(`${r.key.padEnd(9)} ${r.lang}    ${ms(r.liveAfterOnsetMs)}       ${String(r.liveCoverage).padStart(3)}%       ${ms(r.bubbleAfterEndMs)}      ${ms(r.lastPieceAfterEndMs)}     ${String(r.pieces).padStart(2)}    ${String(r.coverage).padStart(3)}%   ${String(r.langOfBubble || '—').padEnd(5)}   ${r.text.slice(0, 56)}`);
  }
  if (report.groq) {
    console.log('\nGroq stand-in saw:');
    for (const q of report.groq) console.log(`  #${q.n} at ${(q.at / 1000).toFixed(2)}s · ${q.seconds}s of audio · language=${q.language ?? '(omitted)'} · ${q.format} · answered as ${q.cue}`);
  }
  if (report.errors.length) console.log('\nerrors:\n  ' + report.errors.join('\n  '));
  const noise = result.console.filter((c) => c.level === 'error' || c.level === 'exception');
  if (noise.length) console.log('\nconsole errors:\n  ' + noise.map((c) => `${c.where}: ${c.text}`).join('\n  '));
  console.log(`\nraw: ${file}`);
}
