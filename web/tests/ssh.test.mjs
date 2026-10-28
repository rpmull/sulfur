import test from 'node:test';
import assert from 'node:assert/strict';
import { askBox, sshFolder, sshLabel, sshNeedBox, sshPath } from '../src/sulfur/ssh.js';
import { hostFixture } from './helpers/host-fixture.mjs';

test('an SSH host is reached through the app\'s own server by its name', () => {
  assert.equal(sshPath('ccm', '/api/files/ccm/list?share=0'), '/api/ssh/ccm/api/files/ccm/list?share=0');
  assert.equal(sshLabel({ user: 'user', host: '172.18.220.63', port: 22 }), 'user@172.18.220.63');
  assert.equal(sshLabel({ user: 'u', host: 'box', port: 2222 }), 'u@box:2222');
});

test('a connection\'s needs are asked masked, a host key\'s trust is not an input', () => {
  assert.deepEqual(sshNeedBox({ need: 'password', error: 'user@box’s password' }, 'box'), { title: 'box: Password', placeholder: 'Password', prompt: 'user@box’s password', password: true });
  assert.equal(sshNeedBox({ need: 'passphrase' }, 'box').password, true);
  assert.equal(sshNeedBox({ need: 'trust', fingerprint: 'SHA256:x' }, 'box'), null);
  assert.equal(sshNeedBox({ error: 'unreachable' }, 'box'), null);
});

test('a folder named in the address opens under the host\'s disk', () => {
  assert.equal(sshFolder('/home/user', '/usr/arconic/ccm'), 'usr/arconic/ccm');
  assert.equal(sshFolder('/home/user', '~/src/app/'), 'home/user/src/app');
  assert.equal(sshFolder('/home/user', '~'), 'home/user');
  assert.equal(sshFolder('/home/user', ''), '');
});

test('git\'s prompts: passwords masked, host keys and user names shown', () => {
  const pw = askBox({ prompt: "user@172.18.220.63's password: ", secret: true });
  assert.equal(pw.password, true);
  assert.equal(pw.prompt, "user@172.18.220.63's password:");
  const key = askBox({ prompt: 'Are you sure you want to continue connecting (yes/no/[fingerprint])? ', secret: false });
  assert.equal(key.password, false);
  assert.equal(key.placeholder, 'yes or no');
  assert.equal(askBox({ prompt: "Username for 'https://git.example.com': " }).password, false);
});

test('connected SSH hosts are machines here, routed to their own API, and leave when dropped', async () => {
  const original = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, setTimeout: globalThis.setTimeout };
  const calls = [];
  const info = { platform: 'linux', shell: 'sh', home: '/home/user', files: { shares: [{ id: 'home', label: '/home', home: true, perms: 'rwd' }, { id: '0', label: '/', perms: 'rwd' }] } };
  let hosts = [{ name: 'ccm', host: '172.18.220.63', port: 22, user: 'user', key: '', connected: false, info: null }];
  globalThis.WebSocket = class { close() {} };
  globalThis.setTimeout = () => 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url === '/api/sidecar/ssh/connect') {
      const b = JSON.parse(init.body);
      if (!b.trust) return Response.json({ error: 'new host', need: 'trust', fingerprint: 'SHA256:abc' }, { status: 401 });
      if (!b.password) return Response.json({ error: 'its password', need: 'password' }, { status: 401 });
      hosts = [{ ...hosts[0], connected: true, info }];
      return Response.json({ ok: true, host: hosts[0] });
    }
    if (url === '/api/sidecar/ssh') return Response.json({ kind: 'ssh', version: 1, caps: ['files'], hosts });
    if (url === '/api/sidecar/ssh/disconnect') { hosts = [{ ...hosts[0], connected: false, info: null }]; return Response.json({ kind: 'ssh', hosts }); }
    return Response.json({ ok: true });
  };
  try {
    const host = await hostFixture();
    let changed = 0;
    host.bootLocal({ host: 'pc', user: 'me', info: { files: { shares: [] } }, asks: true, ssh: { kind: 'ssh', version: 1, caps: ['files'], hosts } });
    host.standalone.onHosts = () => { changed += 1; };
    assert.equal(host.standalone.asks, true);
    assert.deepEqual(host.dkLiveHosts(), ['pc'], 'a saved host isn\'t a machine until connected');
    // routed to the app's own server even before it connects: never the mesh's API, never this computer's
    assert.equal(host.hostUrl('ccm', '/api/files/ccm/read'), '/api/ssh/ccm/api/files/ccm/read');
    assert.equal(host.hostUrl('pc', '/api/files/pc/read'), '/api/files/pc/read');

    assert.equal((await host.standalone.sshConnect('ccm')).need, 'trust');
    assert.equal((await host.standalone.sshConnect('ccm', { trust: 'SHA256:abc' })).need, 'password');
    const ok = await host.standalone.sshConnect('ccm', { trust: 'SHA256:abc', password: 'pw' });
    assert.equal(ok.ok, true);
    assert.deepEqual(host.otherHosts(), ['ccm']);
    assert.deepEqual(host.dkLiveHosts(), ['pc', 'ccm']);
    assert.equal(host.hostsInfo.ccm.home, '/home/user');
    assert.equal(host.dk.creds.get('ccm').user, 'user');
    assert.equal(host.dk.creds.get('ccm').pass, '', 'the page keeps no SSH password');
    assert.match(host.filesApi({ host: 'ccm', share: '0' }, 'list', { path: 'usr' }), /^\/api\/ssh\/ccm\/api\/files\/ccm\/list\?/);
    assert.ok(changed > 0);

    await host.standalone.sshDisconnect('ccm');
    assert.deepEqual(host.otherHosts(), []);
    assert.deepEqual(host.dkLiveHosts(), ['pc']);
    assert.equal(host.hostsInfo.ccm, undefined);
    assert.equal(host.hostUrl('ccm', '/api/files/ccm/read'), '/api/ssh/ccm/api/files/ccm/read', 'an open tab of it still never reaches another host');
  } finally { Object.assign(globalThis, original); }
});

test('git\'s prompts are answered on the page, or refused', async () => {
  const original = { WebSocket: globalThis.WebSocket };
  const sockets = [];
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
    send(d) { this.sent.push(JSON.parse(d)); }
    close() { this.readyState = 3; }
  };
  try {
    const host = await hostFixture();
    const done = [];
    const stop = host.listenAsks(async (m) => (m.secret ? { value: 'hunter2', remember: false } : null), (id) => done.push(id));
    const ws = sockets[0];
    assert.match(ws.url, /\/api\/sulfur\/asks$/);
    await ws.onmessage({ data: JSON.stringify({ type: 'ask', id: 'ask-1', prompt: 'password: ', secret: true }) });
    assert.deepEqual(ws.sent[0], { type: 'answer', id: 'ask-1', value: 'hunter2', remember: false });
    await ws.onmessage({ data: JSON.stringify({ type: 'ask', id: 'ask-2', prompt: 'Continue (yes/no)? ', secret: false }) });
    assert.deepEqual(ws.sent[1], { type: 'cancel', id: 'ask-2' });
    await ws.onmessage({ data: JSON.stringify({ type: 'done', id: 'ask-3' }) });
    assert.deepEqual(done, ['ask-3']);
    stop();
    assert.equal(ws.readyState, 3);
  } finally { Object.assign(globalThis, original); }
});
