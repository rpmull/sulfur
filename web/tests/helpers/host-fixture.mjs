import { readFile } from 'node:fs/promises';
import { meshPeers } from '../../src/sulfur/mesh.js';

let sequence = 0;
export async function hostFixture() {
  // Test the real host and file routing without loading DOM themes or xterm.
  const source = `const location = { protocol: 'http:', host: 'localhost' };\nconst meshPeers = ${meshPeers};\n`
    + (await readFile(new URL('../../src/sulfur/host.js', import.meta.url), 'utf8'))
      .replace('__ASSETS__', '{}')
      .replace("import { themeFromStorage } from '../theme.js';", 'const themeFromStorage = () => {};')
      .replace("import { meshPeers } from './mesh.js';", '')
      .replace(/^export \{[^\n]+\} from '[^']+';$/gm, '')
    + `\n// fixture ${++sequence}\n//# sourceURL=sulfur-host-fixture.mjs`;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
