// Provisional live transcription using the on-device Web Speech API (Chrome 139+).
//
// Whisper remains the authoritative source: this only shows text ahead of it while
// the person is speaking, and it is discarded as soon as the real segment lands.
// Everything produced here is provisional and never stored in the transcript.
//
// Two details that shape the design:
//   - start() accepts a MediaStreamTrack, so the tab's track can be handed to it.
//     Without that it would only hear the microphone, which is useless here.
//   - processLocally requires an installed language pack. If it is missing we say
//     so and stay idle: it NEVER falls back to cloud recognition, because that
//     would ship the other speaker's audio off the machine without telling anyone.

const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

const FATAL = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture']);

export const liveSupported = () => !!SR;

export async function liveAvailability(lang = 'en-US') {
  if (!SR) return 'unsupported';
  if (typeof SR.available !== 'function') return 'unknown';
  try {
    const r = await SR.available({ langs: [lang], processLocally: true });
    if (typeof r === 'string') return r;
    return r ? 'available' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export async function installLive(lang = 'en-US') {
  if (!SR || typeof SR.install !== 'function') return false;
  try {
    return (await SR.install({ langs: [lang], processLocally: true })) !== false;
  } catch {
    return false;
  }
}

export function startLive({ track, lang = 'en-US', onText, onError } = {}) {
  if (!SR || !track) return null;

  let rec = null;
  let wanted = true;
  let base = 0;
  let seen = 0;

  const emit = (results) => {
    seen = results.length;
    let text = '';
    for (let i = base; i < results.length; i++) text += results[i][0]?.transcript || '';
    onText?.(text.trim());
  };

  const build = () => {
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    r.processLocally = true;

    r.onresult = (e) => emit(e.results);
    r.onerror = (e) => {
      const code = e.error || 'unknown';
      if (FATAL.has(code)) {
        wanted = false;
        onError?.(code);
      }
    };
    r.onend = () => {
      if (!wanted) return;
      base = 0;
      seen = 0;
      setTimeout(() => { if (wanted) launch(); }, 300);
    };
    return r;
  };

  const launch = () => {
    try {
      rec = build();
      rec.start(track);
    } catch (e) {
      wanted = false;
      onError?.(e?.message || String(e));
    }
  };

  launch();

  return {
    // Called once Whisper delivered the real segment: the provisional text is moot.
    reset() {
      base = seen;
      onText?.('');
    },
    stop() {
      wanted = false;
      try { rec?.stop(); } catch { /* ya estaba parado */ }
      rec = null;
    },
  };
}
