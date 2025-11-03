
export const up = [
  `CREATE TABLE IF NOT EXISTS relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_symbol_id INTEGER NOT NULL,
    target_symbol_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    scan_id INTEGER,
    FOREIGN KEY(source_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE,
    FOREIGN KEY(target_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE,
    FOREIGN KEY(scan_id) REFERENCES scans(id) ON DELETE SET NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_relations_source_symbol ON relations(source_symbol_id)',
  'CREATE INDEX IF NOT EXISTS idx_relations_target_symbol ON relations(target_symbol_id)',
  'CREATE INDEX IF NOT EXISTS idx_relations_kind ON relations(kind)',
];
