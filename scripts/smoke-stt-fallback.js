// Isolated smoke test: ensure GoogleSTT emits 'fatal_error' without credentials
// and the fallback code can instantiate DeepgramStreamingSTT.

const path = require('path');
const { GoogleSTT } = require(path.join('..', 'dist-electron', 'electron', 'audio', 'GoogleSTT'));
const { DeepgramStreamingSTT } = require(path.join('..', 'dist-electron', 'electron', 'audio', 'DeepgramStreamingSTT'));

console.log('Starting isolated STT fallback smoke test...');

const g = new GoogleSTT();

let fallbackTriggered = false;

g.on('fatal_error', (err) => {
  console.log('GoogleSTT emitted fatal_error:', err && err.message ? err.message : String(err));
  console.log('Simulating main.ts fallback: creating DeepgramStreamingSTT');
  const dg = new DeepgramStreamingSTT('test-api-key');
  dg.on('transcript', (s) => console.log('Deepgram transcript', s));
  dg.on('error', (e) => console.log('Deepgram error', e && e.message ? e.message : e));
  dg.setSampleRate(48000);
  dg.setAudioChannelCount?.(1);
  dg.start?.();
  fallbackTriggered = true;
});

g.on('error', (err) => console.log('GoogleSTT non-fatal error:', err));

// Trigger start which should detect missing credentials and emit fatal_error
g.start();

// Wait a moment to observe events
setTimeout(() => {
  if (!fallbackTriggered) {
    console.error('Smoke test: fallback did NOT trigger');
    process.exitCode = 2;
  } else {
    console.log('Smoke test: fallback triggered successfully');
    process.exitCode = 0;
  }
}, 2000);
