import { DatabaseSync, constants as C } from 'node:sqlite';
import { open, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
export async function sqlite(p) {
  const result = { columns: [], rows: [] };
  let created = false,
    db,
    guardTransaction = false;
  if (!path.isAbsolute(p.path || '') || p.path.includes('\0'))
    throw new Error('choose a full path to a database');
  if (!['create', 'schema', 'query', 'execute'].includes(p.op))
    throw new Error('unknown SQLite operation');
  if (Buffer.byteLength(p.sql || '') > 1 << 20) throw new Error('SQL exceeds 1 MiB');
  if (['query', 'execute'].includes(p.op) && !p.sql?.trim()) throw new Error('enter SQL first');
  if (p.op === 'create') {
    const file = await open(p.path, 'wx', 0o600);
    await file.close();
    created = true;
  } else if (!(await stat(p.path)).isFile()) throw new Error('choose a database file');
  try {
    db = new DatabaseSync(p.path, {
      readOnly: !['execute', 'create'].includes(p.op),
      allowExtension: false,
    });
    db.exec('PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
    // Let SQLite parse and authorize SQL, including complete trigger bodies.
    db.setAuthorizer((action, a, b) => {
      if (action === C.SQLITE_ATTACH && a) return C.SQLITE_DENY;
      if (
        action === C.SQLITE_FUNCTION &&
        ['load_extension', 'readfile', 'writefile'].includes(b?.toLowerCase())
      )
        return C.SQLITE_DENY;
      if (
        action === C.SQLITE_PRAGMA &&
        ['temp_store_directory', 'data_store_directory'].includes(a?.toLowerCase())
      )
        return C.SQLITE_DENY;
      if (guardTransaction && [C.SQLITE_TRANSACTION, C.SQLITE_SAVEPOINT].includes(action))
        return C.SQLITE_DENY;
      return C.SQLITE_OK;
    });
    if (p.op === 'create') {
      db.exec('VACUUM');
      created = false;
      return result;
    }
    if (p.op === 'execute') {
      db.exec('BEGIN');
      try {
        guardTransaction = true;
        db.exec(p.sql);
        guardTransaction = false;
        result.changes = db.prepare('SELECT total_changes() AS n').get().n;
        db.exec('COMMIT');
      } catch (error) {
        guardTransaction = false;
        db.exec('ROLLBACK');
        throw error;
      }
      return result;
    }
    const sql =
      p.op === 'schema'
        ? "SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table','view') AND name NOT GLOB 'sqlite_*' ORDER BY name"
        : p.sql;
    const stmt = db.prepare(sql);
    result.columns = stmt.columns().map((column) => column.name);
    if (result.columns.length > 512) throw new Error('query has more than 512 columns');
    stmt.setReturnArrays(true);
    stmt.setReadBigInts(true);
    let size = 0;
    const limit = p.limit > 0 && p.limit <= 1000 ? p.limit : 200;
    // Streaming bounds work independently of the number of rows SQLite can produce.
    for (const value of stmt.iterate()) {
      const row = value.map((x) =>
        typeof x === 'bigint'
          ? x > BigInt(Number.MAX_SAFE_INTEGER) || x < BigInt(Number.MIN_SAFE_INTEGER)
            ? String(x)
            : Number(x)
          : x instanceof Uint8Array
            ? `BLOB (${x.length} bytes): ${Buffer.from(x.subarray(0, 64)).toString('hex')}`
            : typeof x === 'string' && Buffer.byteLength(x) > 65536
              ? Buffer.from(x).subarray(0, 65536).toString() + '… [truncated]'
              : typeof x === 'number' && !Number.isFinite(x)
                ? String(x)
                : x,
      );
      size += Buffer.byteLength(JSON.stringify(row));
      if (result.rows.length >= limit || size > 8 << 20) {
        result.truncated = true;
        break;
      }
      result.rows.push(row);
    }
    return result;
  } finally {
    db?.close();
    if (created) await unlink(p.path).catch(() => {});
  }
}
export async function sqliteProcess() {
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.write(Buffer.from(chunk));
    if (buffered.length > 8 << 20) throw new Error('SQLite request exceeds limit');
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (!line) continue;
      const { id, request } = JSON.parse(line);
      try {
        process.stdout.write(JSON.stringify({ id, value: await sqlite(request) }) + '\n');
      } catch (error) {
        process.stdout.write(JSON.stringify({ id, error: error.message }) + '\n');
      }
    }
  }
}
