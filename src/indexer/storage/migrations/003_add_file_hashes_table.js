export const up = [
  `CREATE TABLE IF NOT EXISTS file_hashes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,
    hash TEXT NOT NULL,
    indexed_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_file_hashes_path ON file_hashes(file_path)',
];

export const down = async (db) => {
  await db.exec(`
    DROP TABLE file_hashes;
  `);
};