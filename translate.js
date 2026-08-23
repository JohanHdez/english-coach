// Translation into Spanish using Chrome's built-in translator (138+).
// Free, no API key, and the text never leaves the machine. If the browser does not
// expose it, everything keeps working: it simply does not translate.
//
// Limits that shape the design: desktop only, unavailable in Web Workers, and the
// first creation downloads a language model — so it is best kicked off right after
// a user gesture.

let translator = null;
let state = 'idle';   // idle | ready | unavailable

export const translatorState = () => state;

export async function ensureTranslator() {
  if (state === 'ready') return translator;
  if (state === 'unavailable') return null;
  if (typeof Translator === 'undefined') { state = 'unavailable'; return null; }
  try {
    const opts = { sourceLanguage: 'en', targetLanguage: 'es' };
    if ((await Translator.availability(opts)) === 'unavailable') {
      state = 'unavailable';
      return null;
    }
    translator = await Translator.create(opts);
    state = 'ready';
    return translator;
  } catch {
    state = 'unavailable';
    return null;
  }
}

export async function toSpanish(text) {
  if (!text) return '';
  const t = await ensureTranslator();
  if (!t) return '';
  try {
    return (await t.translate(text)).trim();
  } catch {
    return '';
  }
}
