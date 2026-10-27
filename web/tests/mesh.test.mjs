import test from 'node:test';
import assert from 'node:assert/strict';
import { meshPeers, supportsMesh } from '../src/sulfur/mesh.js';

test('legacy Phosphorus state keeps only Phosphorus hosts', () => {
  assert.deepEqual(meshPeers({ tailnet: [{ name: 'b', phosphorus: true }, { name: 'a', phosphorus: true }, { name: 'vpn-only' }] }), ['a', 'b']);
});

test('normalized peers work without Phosphorus and omit disconnected machines', () => {
  assert.deepEqual(meshPeers({ peers: [{ name: 'b' }, { name: 'a', online: true }, { name: 'a' }, { name: 'off', online: false }, {}, null], tailnet: [{ name: 'legacy', phosphorus: true }] }), ['a', 'b']);
  assert.deepEqual(meshPeers({ peers: [], tailnet: [{ name: 'legacy', phosphorus: true }] }), []);
});

test('embedded and older Phosphorus hosts retain every existing mesh capability', () => {
  for (const host of [null, { mode: 'mesh' }, { mode: 'local', server: 'https://mesh' }]) {
    for (const cap of ['files', 'home', 'sessions', 'terminals', 'agents', 'models', 'forgejo', 'people']) assert.equal(supportsMesh(host, cap), true);
  }
  assert.equal(supportsMesh({ mode: 'local' }, 'agents'), false);
});

test('explicit capabilities control optional services independently of mesh kind', () => {
  const mesh = { kind: 'overlay', version: 1, caps: ['hosts', 'files', 'sessions', 'terminals'] };
  assert.equal(supportsMesh({ mode: 'local', server: 'overlay', mesh }, 'files'), true);
  assert.equal(supportsMesh({ mode: 'local', server: 'overlay', mesh }, 'forgejo'), false);
  assert.equal(supportsMesh({ mode: 'mesh', info: { mesh } }, 'agents'), false);
  assert.equal(supportsMesh({ mode: 'mesh', mesh: { kind: 'overlay' } }, 'agents'), false);
  assert.equal(supportsMesh({ mode: 'mesh', mesh: { caps: [] } }, 'files'), false);
});
