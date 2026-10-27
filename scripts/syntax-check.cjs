// Parse every file in one process without linking, evaluating or emitting code.
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
for (const file of process.argv.slice(2)) {
  const source = readFileSync(file, 'utf8');
  if (file.endsWith('.cjs')) new vm.Script(source, { filename: file });
  else new vm.SourceTextModule(source, { identifier: file });
}
