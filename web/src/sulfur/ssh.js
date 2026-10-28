// SSH hosts as the page reaches them: machines saved by address (user@host), served by
// the app's own server under /api/ssh/<name>/ with the same files, sessions, terminals,
// runs, git and toolchains APIs a mesh's host gives. Pure helpers, kept apart for tests.

// a host's API path through the app's own server
export const sshPath = (host, path) => `/api/ssh/${encodeURIComponent(host)}${path}`;

// how a saved host is shown: user@host, its port when it isn't ssh's
export const sshLabel = (h) => `${h.user}@${h.host}${h.port && h.port !== 22 ? `:${h.port}` : ''}`;

// the input box that asks what a connection needs: its password or its key's passphrase
// (masked); null for a refusal that isn't a question (a host key's trust is a pick)
export function sshNeedBox(r, name) {
  if (r?.need === 'password') return { title: `${name}: Password`, placeholder: 'Password', prompt: r.error || '', password: true };
  if (r?.need === 'passphrase') return { title: `${name}: Key Passphrase`, placeholder: 'Passphrase', prompt: r.error || '', password: true };
  return null;
}

// a folder named with the address (user@host:/srv/code, user@host:~/src) as a path
// under the host's whole disk (share '0', '/'), its home for ~
export function sshFolder(home, path) {
  const p = String(path || '').trim();
  if (!p) return '';
  const abs = p === '~' || p.startsWith('~/') ? `${String(home || '').replace(/\/+$/, '')}${p.slice(1)}` : p;
  return abs.replace(/^\/+/, '').replace(/\/+$/, '');
}

// git's prompt (an SSH password, a key's passphrase, a new host's key, an HTTPS login)
// as the input box asks it; secrets masked
export function askBox(m) {
  const prompt = String(m?.prompt || '').trim();
  const yesNo = /\(yes\/no/i.test(prompt);
  return {
    title: m?.secret ? 'Git: Password Needed' : 'Git Asks',
    placeholder: m?.secret ? 'Password or passphrase' : yesNo ? 'yes or no' : '',
    prompt,
    password: !!m?.secret,
  };
}
