'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHost, summarize, validateExe, validateState } = require('../app/domain.cjs');

test('accepts IPv4, IPv6 and DNS names for the ICMP test', () => {
  assert.equal(normalizeHost('  EXAMPLE.org. '), 'example.org');
  assert.equal(normalizeHost('1.1.1.1'), '1.1.1.1');
  assert.equal(normalizeHost('2001:db8::1'), '2001:db8::1');
  for (const invalid of ['https://example.org', 'host:443', '1.2.3.999', '', '-host', "host'; cmd", 'a..b']) {
    assert.throws(() => normalizeHost(invalid));
  }
});

test('keeps zero millisecond replies and preserves gaps in the jitter calculation', () => {
  assert.deepEqual(summarize([0, 10, null, 90, 95]), { average: 49, jitter: 8, loss: 20 });
  assert.deepEqual(summarize([null, null]), { average: null, jitter: null, loss: 100 });
});

test('accepts a local executable and rejects paths that cannot identify a local app', () => {
  assert.equal(validateExe('C:\\Игры\\Racing.EXE'), 'C:\\Игры\\Racing.EXE');
  for (const invalid of ['\\\\server\\share\\app.exe', 'C:\\apps\\*.exe', 'C:app.exe', 'C:\\app.exe:alt', 'C:\\script.ps1']) {
    assert.throws(() => validateExe(invalid));
  }
});

test('recognizes pending recovery journals and rejects malformed records', () => {
  const profile = {
    plan: null,
    complete: false,
    capture: [{ name: 'GameDVR_Enabled', value: null }, { name: 'AppCaptureEnabled', value: 1 }]
  };
  assert.deepEqual(validateState({ version: 1, profile }), { version: 1, profile });
  assert.throws(() => validateState({ version: 1, profile: { ...profile, capture: [] } }));
  assert.throws(() => validateState({ version: 1, qos: { name: 'Other policy', complete: true, rate: 5, file: 'C:\\a.exe' } }));
});
