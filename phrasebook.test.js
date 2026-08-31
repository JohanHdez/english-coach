import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOGUE, DEFAULT_PHRASE_IDS, resolvePhrases, resolveNotes, resolveChips,
  NOTE_TITLE_MAX, NOTE_BODY_MAX, MAX_NOTES, MAX_CUSTOM, toggleNoteOpen,
} from './phrasebook.js';

const allItems = () => CATALOGUE.flatMap((c) => c.items);

test('every catalogue id is unique', () => {
  const ids = allItems().map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every catalogue entry carries English and a Spanish gloss', () => {
  for (const item of allItems()) {
    assert.ok(item.en && item.en.trim(), `${item.id} has no en`);
    assert.ok(item.es && item.es.trim(), `${item.id} has no es`);
  }
});

test('every seeded default exists in the catalogue', () => {
  const ids = new Set(allItems().map((i) => i.id));
  for (const id of DEFAULT_PHRASE_IDS) assert.ok(ids.has(id), `${id} is not in the catalogue`);
});

test('resolvePhrases returns built-ins in catalogue order, then customs', () => {
  const out = resolvePhrases({
    phraseIds: ['close.sum-up', 'time.second'],
    customPhrases: [{ id: 'u.1', en: 'Ship it,', es: 'a producción' }],
  });
  assert.deepEqual(out.map((p) => p.id), ['time.second', 'close.sum-up', 'u.1']);
});

test('resolvePhrases drops ids no longer in the catalogue instead of throwing', () => {
  const out = resolvePhrases({ phraseIds: ['time.second', 'gone.forever'] });
  assert.deepEqual(out.map((p) => p.id), ['time.second']);
});

test('resolvePhrases on empty settings returns the seeded defaults, not nothing', () => {
  const out = resolvePhrases({});
  assert.equal(out.length, DEFAULT_PHRASE_IDS.length);
  assert.ok(out.length > 0);
});

test('an explicitly empty selection stays empty', () => {
  assert.deepEqual(resolvePhrases({ phraseIds: [] }), []);
});

test('resolvePhrases caps the learner custom phrases', () => {
  const customPhrases = Array.from({ length: MAX_CUSTOM + 10 }, (_, i) => ({
    id: `u.${i}`, en: `phrase ${i}`, es: `frase ${i}`,
  }));
  const out = resolvePhrases({ phraseIds: [], customPhrases });
  assert.equal(out.length, MAX_CUSTOM);
});

test('resolvePhrases discards custom phrases with no English', () => {
  const out = resolvePhrases({ phraseIds: [], customPhrases: [{ id: 'u.1', en: '  ', es: 'x' }] });
  assert.deepEqual(out, []);
});

test('a custom phrase id cannot collide with a catalogue id', () => {
  // Settings writes them as 'u.' + timestamp; no catalogue id may start with 'u.'
  for (const item of allItems()) assert.ok(!item.id.startsWith('u.'), `${item.id} collides`);
});

test('resolveNotes clamps title, body and count', () => {
  const notes = Array.from({ length: MAX_NOTES + 5 }, (_, i) => ({
    id: `n.${i}`, title: 'T'.repeat(NOTE_TITLE_MAX + 20), body: 'B'.repeat(NOTE_BODY_MAX + 500),
  }));
  const out = resolveNotes({ notes });
  assert.equal(out.length, MAX_NOTES);
  assert.equal(out[0].title.length, NOTE_TITLE_MAX);
  assert.equal(out[0].body.length, NOTE_BODY_MAX);
});

test('resolveNotes preserves the open state through a round trip', () => {
  const out = resolveNotes({ notes: [{ id: 'n.1', title: 'Mi daily', body: 'x', open: true }] });
  assert.equal(out[0].open, true);
  assert.equal(resolveNotes({ notes: out })[0].open, true);
});

test('resolveNotes defaults a note to closed and never returns undefined fields', () => {
  const [note] = resolveNotes({ notes: [{ id: 'n.1', title: 'Sin cuerpo' }] });
  assert.equal(note.open, false);
  assert.equal(note.body, '');
});

test('resolveNotes on empty settings returns an empty list', () => {
  assert.deepEqual(resolveNotes({}), []);
  assert.deepEqual(resolveNotes({ notes: null }), []);
});

test('resolveChips returns empty phrases and notes when liveCoach is false', () => {
  const settings = {
    liveCoach: false,
    phraseIds: ['time.second'],
    notes: [{ id: 'n.1', title: 'Mi daily', body: 'x', open: true }],
  };
  assert.deepEqual(resolveChips(settings), { phrases: [], notes: [] });
});

test('resolveChips defaults to on and returns the seeded phrases when liveCoach is absent', () => {
  const out = resolveChips({});
  assert.equal(out.phrases.length, DEFAULT_PHRASE_IDS.length);
  assert.deepEqual(out.notes, []);
});

test('resolveChips returns content when liveCoach is true', () => {
  const settings = {
    liveCoach: true,
    phraseIds: ['time.second'],
    notes: [{ id: 'n.1', title: 'Mi daily', body: 'x', open: true }],
  };
  const out = resolveChips(settings);
  assert.deepEqual(out.phrases.map((p) => p.id), ['time.second']);
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].id, 'n.1');
});

test('toggleNoteOpen flips the targeted note and returns a new settings object', () => {
  const settings = {
    liveCoach: true,
    notes: [{ id: 'n.1', title: 'Mi daily', body: 'x', open: false }],
  };
  const out = toggleNoteOpen(settings, 'n.1');
  assert.equal(out.notes[0].open, true);
  assert.equal(settings.notes[0].open, false, 'the input must not be mutated');
  assert.notEqual(out, settings);
  assert.equal(out.liveCoach, true, 'the rest of settings survives');
  assert.equal(toggleNoteOpen(out, 'n.1').notes[0].open, false);
});

test('toggleNoteOpen leaves the other notes untouched', () => {
  const settings = {
    notes: [
      { id: 'n.1', title: 'a', body: 'x', open: true },
      { id: 'n.2', title: 'b', body: 'y', open: false },
      { id: 'n.3', title: 'c', body: 'z', open: true },
    ],
  };
  const out = toggleNoteOpen(settings, 'n.2');
  assert.deepEqual(out.notes.map((n) => n.open), [true, true, true]);
  assert.deepEqual(out.notes.map((n) => n.title), ['a', 'b', 'c']);
});

test('toggleNoteOpen on an id that matches nothing changes nothing', () => {
  const settings = { notes: [{ id: 'n.1', title: 'a', body: 'x', open: false }] };
  assert.deepEqual(toggleNoteOpen(settings, 'n.9').notes, settings.notes);
  assert.deepEqual(toggleNoteOpen({}, 'n.9').notes, []);
});
