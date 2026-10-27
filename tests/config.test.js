import { test, expect } from 'bun:test';
import Ajv from 'ajv';
import schema from '../node_modules/@tauri-apps/cli/config.schema.json';
import config from '../src-tauri/tauri.conf.json';
import { readFile } from 'node:fs/promises';
import { meshInfo, meshProvider, registerMeshProvider, serverURL } from '../server/mesh.js';
test('native configuration follows the pinned Tauri schema without running a build', async () => {
  const validate = new Ajv({
    strict: false,
    validateFormats: false,
    unicodeRegExp: false,
    inlineRefs: false,
    allErrors: true,
  }).compile(schema);
  expect(validate(config), JSON.stringify(validate.errors)).toBe(true);
  for (const platform of ['windows', 'macos', 'linux']) {
    const local = JSON.parse(await readFile(`src-tauri/tauri.${platform}.conf.json`, 'utf8'));
    expect(
      validate({ ...config, ...local, bundle: { ...config.bundle, ...local.bundle } }),
      JSON.stringify(validate.errors),
    ).toBe(true);
  }
  expect(config.identifier).toBe('dev.phosphorus.sulfur');
  expect(config.build.frontendDist).toBe('http://127.0.0.1:47615/sulfur/');
}, 30000);
test('mesh capabilities stay explicit and legacy Phosphorus links keep the full shared-home boundary', () => {
  expect(serverURL('example.com')).toBe('https://example.com');
  expect(serverURL('workstation')).toBe('http://workstation');
  expect(serverURL('node.ts.net')).toBe('http://node.ts.net');
  expect(meshInfo({}).caps).toContain('home');
  expect(meshInfo({}).caps).toContain('people');
  registerMeshProvider({
    kind: 'test-files',
    version: 1,
    caps: ['hosts', 'files'],
    normalize: serverURL,
    async reach() {},
  });
  expect(meshInfo({ kind: 'test-files' }).caps).toEqual(['hosts', 'files']);
  expect(meshProvider('test-files').caps).not.toContain('models');
  expect(() => meshProvider('unknown')).toThrow('unknown');
});
