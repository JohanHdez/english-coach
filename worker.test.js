import test from 'node:test';
import assert from 'node:assert/strict';
import { langFromToken, loadAttempts, modelForLang } from './worker.js';

test('a Spanish session swaps the English-only model for the multilingual one', () => {
  assert.equal(modelForLang('onnx-community/whisper-base.en', 'es'), 'onnx-community/whisper-base');
  assert.equal(modelForLang('onnx-community/whisper-small.en', 'es'), 'onnx-community/whisper-small');
  assert.equal(modelForLang('onnx-community/whisper-base', 'es'), 'onnx-community/whisper-base');
});

test('an English session keeps the configured model untouched', () => {
  assert.equal(modelForLang('onnx-community/whisper-base.en', 'en'), 'onnx-community/whisper-base.en');
  assert.equal(modelForLang('onnx-community/whisper-base.en', undefined), 'onnx-community/whisper-base.en');
});

test('a bilingual session loads the multilingual model', () => {
  // The .en exports only understand English, so a bilingual meeting would transcribe
  // every Spanish turn as English that was never said.
  assert.equal(modelForLang('onnx-community/whisper-base.en', 'multi'), 'onnx-community/whisper-base');
  assert.equal(modelForLang('onnx-community/whisper-small.en', 'multi'), 'onnx-community/whisper-small');
  assert.equal(modelForLang('onnx-community/whisper-tiny.en', 'multi'), 'onnx-community/whisper-tiny');
});

// q8 is deliberately absent: the vendored ONNX Runtime (1.26) rejects every old
// q8 Whisper export, so that rung always failed. Restore q8 first when vendor/
// carries ort-web >= 1.27.
test('webgpu ladder tries q4 first, then fp32, then the wasm ladder', () => {
  assert.deepEqual(loadAttempts('webgpu'), [
    ['webgpu', 'q4'], ['webgpu', 'fp32'],
    ['wasm', 'q4'], ['wasm', 'fp32'],
  ]);
});

test('wasm ladder never touches webgpu and ends unquantized', () => {
  const attempts = loadAttempts('wasm');
  assert.deepEqual(attempts, [['wasm', 'q4'], ['wasm', 'fp32']]);
  assert.ok(attempts.every(([dev]) => dev === 'wasm'));
  assert.equal(attempts.at(-1)[1], 'fp32');
});

test('langFromToken maps the two languages in scope and nothing else', () => {
  const lang_to_id = { '<|en|>': 50259, '<|es|>': 50262, '<|fr|>': 50265 };
  assert.equal(langFromToken(lang_to_id, 50259), 'en');
  assert.equal(langFromToken(lang_to_id, 50262), 'es');
  // A third language is no evidence for either of the two the product knows.
  assert.equal(langFromToken(lang_to_id, 50265), null);
  assert.equal(langFromToken(lang_to_id, 1), null);
  assert.equal(langFromToken(null, 50259), null);
});
