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
