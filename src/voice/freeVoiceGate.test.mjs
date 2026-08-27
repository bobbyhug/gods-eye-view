import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldUseFreeVoice } from './freeVoice.js';

test('free voice takes over when Realtime cannot run', () => {
  assert.equal(shouldUseFreeVoice({ realtimeReady: false, speechSupported: true }), true);
});

test('free voice stands aside when Realtime is actually available', () => {
  assert.equal(shouldUseFreeVoice({ realtimeReady: true, speechSupported: true }), false);
});

test('a missing OpenRouter key does NOT disable voice', () => {
  // THE REGRESSION THIS GUARDS. The old gate also required the OpenRouter key,
  // which is absent in production because it lives in a gitignored .env. The
  // free path never bound, the microphone stayed on the OpenAI Realtime
  // controller, and clicking it told the user "OPENAI_API_KEY is not set" —
  // a key they had no way to supply. The predicate must not consider it.
  assert.equal(
    shouldUseFreeVoice({ realtimeReady: false, speechSupported: true, aiConfigured: false }),
    true
  );
  // And it must reach the same answer whatever that flag says.
  assert.equal(
    shouldUseFreeVoice({ realtimeReady: false, speechSupported: true, aiConfigured: true }),
    shouldUseFreeVoice({ realtimeReady: false, speechSupported: true, aiConfigured: false })
  );
});

test('a browser without speech support gets no free voice', () => {
  // Firefox has no SpeechRecognition; binding the mic there would be a button
  // that silently does nothing.
  assert.equal(shouldUseFreeVoice({ realtimeReady: false, speechSupported: false }), false);
});

test('Realtime wins over free voice even on an unsupported browser', () => {
  assert.equal(shouldUseFreeVoice({ realtimeReady: true, speechSupported: false }), false);
});

test('an absent state object never binds the microphone', () => {
  assert.equal(shouldUseFreeVoice(), false);
  assert.equal(shouldUseFreeVoice({}), false);
});

test('only a literal true for speech support counts', () => {
  // Guards against a truthy-but-wrong value (a string, an object) being read
  // as support and binding a microphone that cannot listen.
  assert.equal(shouldUseFreeVoice({ realtimeReady: false, speechSupported: 'yes' }), false);
  assert.equal(shouldUseFreeVoice({ realtimeReady: false, speechSupported: 1 }), false);
});
