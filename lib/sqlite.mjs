// Magpie runs Bun; standalone development uses Node 22.13+.
export async function openDatabase(path, { readonly = true } = {}) {
  if (process.versions.bun) {
    const { Database } = await import('bun:sqlite');
    const db = new Database(path, { readonly, create: !readonly, strict: true });
    const statements = new Set();
    return {
      exec: sql => db.exec(sql),
      prepare(sql) { const statement = db.prepare(sql); statements.add(statement); return statement; },
      close() {
        // Plain prepare() statements are not owned by Bun's query cache.
        // Explicit finalization is required before rename/delete on Windows.
        for (const statement of statements) statement.finalize();
        statements.clear();
        db.close(true);
      },
    };
  }
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path, { readOnly: readonly, allowExtension: false });
}
export async function validateSQLite(path) {
  const db = await openDatabase(path);
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
    const rows = db.prepare('PRAGMA quick_check').all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new Error('SQLite 完整性校验失败');
    // Force a schema read too, without returning any private table/message contents.
    db.prepare('SELECT count(*) AS n FROM sqlite_schema').get();
  } finally { db.close(); }
}
/**
 * Return the safe page count to keep when PRAGMA quick_check only reports
 * trailing preallocated all-zero pages as "never used", or null otherwise.
 */
export async function findTrailingUnusedPages(path, minKeepPages, totalPages) {
  if (!Number.isSafeInteger(minKeepPages) || !Number.isSafeInteger(totalPages) || minKeepPages >= totalPages) return null;
  const maxErrors = Math.max(100, (totalPages - minKeepPages) + 100);
  if (!Number.isSafeInteger(maxErrors)) return null;
  const db = await openDatabase(path);
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
    const rows = db.prepare(`PRAGMA quick_check(${maxErrors})`).all();
    const lines = [];
    for (const row of rows) {
      for (const part of String(Object.values(row)[0] ?? '').split(/\r?\n/)) {
        const line = part.trim();
        if (line) lines.push(line);
      }
    }
    if (lines[0]?.startsWith('*** in database ')) lines.shift();
    if (!lines.length || (lines.length === 1 && lines[0] === 'ok')) return null;
    const seen = new Set();
    let min = totalPages + 1, max = 0;
    for (const line of lines) {
      const match = /^Page (\d+): never used$/.exec(line);
      if (!match) return null;
      const page = Number(match[1]);
      if (!Number.isSafeInteger(page) || page <= minKeepPages || page > totalPages || seen.has(page)) return null;
      seen.add(page);
      if (page < min) min = page;
      if (page > max) max = page;
    }
    if (max !== totalPages || max - min + 1 !== seen.size) return null;
    db.prepare('SELECT count(*) AS n FROM sqlite_schema').get();
    return min - 1;
  } catch {
    return null;
  } finally { db.close(); }
}
