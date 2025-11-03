
export const up = [
  `CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    total_files INTEGER NOT NULL,
    pattern TEXT,
    duration_ms INTEGER,
    notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    language TEXT,
    hash TEXT,
    size INTEGER,
    last_indexed_at TEXT,
    last_scan_id INTEGER,
    metadata TEXT,
    FOREIGN KEY(last_scan_id) REFERENCES scans(id) ON DELETE SET NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)',
  'CREATE INDEX IF NOT EXISTS idx_files_language ON files(language)',
  `CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    scan_id INTEGER,
    name TEXT,
    kind TEXT,
    signature TEXT,
    line INTEGER,
    metadata TEXT,
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY(scan_id) REFERENCES scans(id) ON DELETE SET NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id)',
  'CREATE INDEX IF NOT EXISTS idx_symbols_scan ON symbols(scan_id)',
  'CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)',
  `CREATE VIRTUAL TABLE IF NOT EXISTS file_contents USING fts5(file_id, content)`,
];
