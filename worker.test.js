import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAttempts, modelForLang } from './worker.js';

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
