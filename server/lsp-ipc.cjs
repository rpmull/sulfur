'use strict';
const { fork } = require('child_process');
const [entry, ...args] = process.argv.slice(2);
const child = fork(entry, [...args, '--node-ipc', '--clientProcessId=' + process.pid], {
  silent: true,
  cwd: process.cwd(),
});
child.stdout.pipe(process.stderr);
child.stderr.pipe(process.stderr);
child.on('message', (m) => {
  const body = Buffer.from(JSON.stringify(m), 'utf8');
  process.stdout.write(
    Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'), body]),
  );
});
child.on('exit', (code) => process.exit(code == null ? 1 : code));
let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const head = buf.indexOf('\r\n\r\n');
    if (head < 0) return;
    const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, head).toString('ascii'));
    if (!m) {
      buf = buf.subarray(head + 4);
      continue;
    }
    const end = head + 4 + Number(m[1]);
    if (buf.length < end) return;
    const msg = JSON.parse(buf.subarray(head + 4, end).toString('utf8'));
    buf = buf.subarray(end);
    if (child.connected) child.send(msg);
  }
});
process.stdin.on('end', () => child.kill());
