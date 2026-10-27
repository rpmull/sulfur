import { readFile, writeFile, mkdir, symlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import patches from './grammar-patches.json';
export async function prepare() {
  for (const [name, changes] of Object.entries(patches))
    for (const patch of changes)
      for (const file of patch.files) {
        const target = path.resolve('node_modules', name, file);
        let text = await readFile(target, 'utf8');
        if (text.includes(patch.new)) continue;
        if (text.split(patch.old).length !== 2)
          throw new Error(`${name}/${file}: pinned grammar patch no longer applies`);
        text = text.replace(patch.old, patch.new);
        await writeFile(target, text);
      }
  await mkdir('web/.vendor', { recursive: true });
  const target = path.resolve('web/.vendor/node_modules');
  if (!(await lstat(target).catch(() => null)))
    await symlink(
      path.resolve('node_modules'),
      target,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
}
if (import.meta.main) await prepare();
