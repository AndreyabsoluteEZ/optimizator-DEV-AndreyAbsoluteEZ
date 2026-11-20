'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { balanced, normalizeHost, profileChanges, selectProfilePower, summarize, validateExe, validateState } = require('../app/domain.cjs');

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

test('chooses an AC power mode on Balanced and falls back to a listed scheme', () => {
  const defaultMode = '00000000-0000-0000-0000-000000000000';
  const bestMode = 'ded574b5-45a0-4f42-8737-46345c09c238';
  const highScheme = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
  assert.deepEqual(selectProfilePower(balanced, balanced, defaultMode), {
    plan: null, acMode: { before: defaultMode, target: bestMode }, powerAlready: false
  });
  assert.deepEqual(selectProfilePower(balanced, balanced, bestMode), {
    plan: null, acMode: null, powerAlready: true
  });
  assert.deepEqual(selectProfilePower(balanced, highScheme, null), {
    plan: { before: balanced, target: highScheme }, acMode: null, powerAlready: false
  });
  assert.deepEqual(selectProfilePower(highScheme, highScheme, null), {
    plan: null, acMode: null, powerAlready: true
  });
  assert.deepEqual(selectProfilePower(balanced, balanced, null), {
    plan: null, acMode: null, powerAlready: false
  });
});

test('separates changed settings from an already applied power and capture configuration', () => {
  const capture = [{ name: 'GameDVR_Enabled', value: 0 }, { name: 'AppCaptureEnabled', value: 0 }];
  const profile = {
    ...selectProfilePower(balanced, balanced, '00000000-0000-0000-0000-000000000000'),
    capture,
    complete: true
  };
  assert.deepEqual(profileChanges(profile), { power: 'ac-mode', capture: false });
  assert.deepEqual(profileChanges({ plan: null, capture }), { power: 'original', capture: false });
  assert.deepEqual(validateState({ version: 1, profile }), { version: 1, profile });
  assert.throws(() => validateState({
    version: 1, profile: { ...profile, acMode: { ...profile.acMode, target: balanced } }
  }));
});
