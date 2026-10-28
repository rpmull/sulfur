import { test, expect } from 'bun:test';
import Ajv from 'ajv';
import schema from '../node_modules/@tauri-apps/cli/config.schema.json';
import config from '../src-tauri/tauri.conf.json';
import { readFile } from 'node:fs/promises';
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
  // the service runs in the app: no sidecar, no resource folder, and the installer wears Sulfur's icon
  expect(config.bundle.externalBin).toBeUndefined();
  expect(config.bundle.windows.nsis.installerIcon).toBe('../packaging/sulfur/icons/icon.ico');
}, 30000);
