import { promises as fs } from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const DB_FILENAME = 'index.db';
const SQLITE_BIN = process.env.AIRA_SQLITE_BIN || 'sqlite3';
let sqliteVerified = false;

const escapeText = (value) => {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).replace(/'/g, "''");
};

const ensureSqlTerminated = (sql) => {
  const trimmed = sql.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
};

const ensureSqliteAvailable = async () => {
  if (sqliteVerified) {
    return;
  }
  try {
    await execFileAsync(SQLITE_BIN, ['-version']);
    sqliteVerified = true;
  } catch (error) {
    const message =
      error?.code === 'ENOENT'
        ? `sqlite3 binary "${SQLITE_BIN}" not found. Install SQLite3 or set AIRA_SQLITE_BIN to a valid executable.`
        : `Failed to execute sqlite3 (${SQLITE_BIN}): ${error.message ?? error}`;
    throw new Error(message);
  }
};

const runSqlScript = async (dbPath, statements) => {
  if (!Array.isArray(statements) || !statements.length) {
    return '';
  }
  const sanitized = statements.map(ensureSqlTerminated).filter(Boolean);
  if (!sanitized.length) {
    return '';
  }
  const script = `${sanitized.join('\n')}\n.exit\n`;

  await ensureSqliteAvailable();
  return new Promise((resolve, reject) => {
    const child = spawn(SQLITE_BIN, ['-batch', dbPath]);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`sqlite3 exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      if (stderr && stderr.trim()) {
        reject(new Error(`sqlite3 stderr: ${stderr.trim()}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.stdin.end(script);
  });
};

const runJsonQuery = async (dbPath, sql) => {
  const normalized = ensureSqlTerminated(sql);
  await ensureSqliteAvailable();
  const { stdout, stderr } = await execFileAsync(SQLITE_BIN, ['-json', '-batch', dbPath, normalized]);
  if (stderr && stderr.trim()) {
    throw new Error(`sqlite3 stderr: ${stderr.trim()}`);
  }
  if (!stdout || !stdout.trim()) {
    return [];
  }
  return JSON.parse(stdout);
};

const getDbPath = (indexRoot) => path.join(indexRoot, DB_FILENAME);

export const ensureSchema = async (indexRoot) => {
  await fs.mkdir(indexRoot, { recursive: true });
  const dbPath = getDbPath(indexRoot);
  await runSqlScript(dbPath, [
    "PRAGMA journal_mode=WAL",
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
  ]);
  return dbPath;
};

const buildFileInsertStatements = ({ files, scanId, indexedAt }) =>
  files.map(({ path: filePath, language }) => {
    const escapedPath = escapeText(filePath);
    const escapedLanguage = escapeText(language ?? '');
    const timestamp = escapeText(indexedAt);
    return `INSERT INTO files (path, language, last_indexed_at, last_scan_id)
      VALUES ('${escapedPath}', '${escapedLanguage}', '${timestamp}', ${scanId})
      ON CONFLICT(path) DO UPDATE SET
        language=excluded.language,
        last_indexed_at=excluded.last_indexed_at,
        last_scan_id=excluded.last_scan_id`;
  });

const buildSymbolInsertStatements = ({ entries, scanId, fileIdMap }) => {
  const statements = [];
  const fileIdsToClear = new Set();

  entries.forEach((entry) => {
    const fileId =
      entry.fileId ??
      (entry.filePath && fileIdMap ? fileIdMap[entry.filePath] : undefined);
    if (!fileId) {
      return;
    }

    fileIdsToClear.add(fileId);

    const name = escapeText(entry.name ?? '');
    const kind = escapeText(entry.kind ?? 'symbol');
    const signature = entry.signature ? `'${escapeText(entry.signature)}'` : 'NULL';
    const line =
      typeof entry.line === 'number' && Number.isFinite(entry.line)
        ? Math.max(0, Math.floor(entry.line))
        : 'NULL';
    const metadata =
      entry.metadata && Object.keys(entry.metadata).length
        ? `'${escapeText(JSON.stringify(entry.metadata))}'`
        : 'NULL';
    const scanColumn = Number.isFinite(scanId) ? scanId : 'NULL';

    statements.push(
      `INSERT INTO symbols (file_id, scan_id, name, kind, signature, line, metadata)
        VALUES (${fileId}, ${scanColumn}, '${name}', '${kind}', ${signature}, ${line}, ${metadata})`,
    );
  });
  return { statements, fileIdsToClear };
};

export const recordFileScan = async ({
  indexRoot,
  summary,
  files = [],
  startedAt,
  completedAt,
  notes,
}) => {
  const dbPath = await ensureSchema(indexRoot);
  const start = startedAt ?? new Date().toISOString();
  const end = completedAt ?? start;
  const totalFiles = summary?.totalFiles ?? files.length ?? 0;
  const duration = summary?.durationMs ?? null;
  const pattern = summary?.pattern ?? null;

  await runSqlScript(dbPath, [
    'BEGIN',
    `INSERT INTO scans (started_at, completed_at, total_files, pattern, duration_ms, notes)
      VALUES ('${escapeText(start)}', '${escapeText(end)}', ${totalFiles},
        ${pattern ? `'${escapeText(pattern)}'` : 'NULL'},
        ${duration !== null ? duration : 'NULL'},
        ${notes ? `'${escapeText(notes)}'` : 'NULL'})`,
    'COMMIT',
  ]);

  const [{ id: scanId }] = await runJsonQuery(
    dbPath,
    'SELECT MAX(id) AS id FROM scans',
  );

  if (files.length) {
    const statements = [
      'BEGIN',
      ...buildFileInsertStatements({
        files,
        scanId,
        indexedAt: end,
      }),
      'COMMIT',
    ];
    await runSqlScript(dbPath, statements);
  }

  const fileRows = await runJsonQuery(
    dbPath,
    `SELECT id, path FROM files WHERE last_scan_id = ${scanId}`,
  );
  const fileIdMap = {};
  fileRows.forEach((row) => {
    fileIdMap[row.path] = row.id;
  });

  return { scanId, fileIdMap };
};

export const listFiles = async (indexRoot) => {
  const dbPath = getDbPath(indexRoot);
  return runJsonQuery(
    dbPath,
    'SELECT path, language, last_indexed_at AS lastIndexedAt, last_scan_id AS lastScanId FROM files ORDER BY path',
  );
};

export const listScans = async (indexRoot) => {
  const dbPath = getDbPath(indexRoot);
  return runJsonQuery(
    dbPath,
    'SELECT id, started_at AS startedAt, completed_at AS completedAt, total_files AS totalFiles, pattern, duration_ms AS durationMs FROM scans ORDER BY id DESC',
  );
};

export const upsertSymbols = async ({ indexRoot, scanId, symbols = [], fileIdMap = {} }) => {
  if (!Array.isArray(symbols) || !symbols.length) {
    return { inserted: 0 };
  }
  const dbPath = await ensureSchema(indexRoot);
  const { statements, fileIdsToClear } = buildSymbolInsertStatements({
    entries: symbols,
    scanId,
    fileIdMap,
  });
  if (!statements.length) {
    return { inserted: 0 };
  }
  const deleteTargets = Array.from(fileIdsToClear)
    .map((fileId) => Number.parseInt(fileId, 10))
    .filter((value) => Number.isInteger(value));
  const deleteStatements =
    deleteTargets.length > 0
      ? [`DELETE FROM symbols WHERE file_id IN (${deleteTargets.join(',')})`]
      : [];
  await runSqlScript(dbPath, ['BEGIN', ...deleteStatements, ...statements, 'COMMIT']);
  return { inserted: statements.length };
};

export const listSymbols = async (indexRoot, { limit = 200 } = {}) => {
  const dbPath = getDbPath(indexRoot);
  return runJsonQuery(
    dbPath,
    `SELECT s.id, f.path AS filePath, s.name, s.kind, s.signature, s.line, s.scan_id AS scanId
     FROM symbols s
     JOIN files f ON f.id = s.file_id
     ORDER BY s.id DESC
     LIMIT ${Math.max(1, Number(limit) || 200)}`,
  );
};

export const __internals = {
  runSqlScript,
  runJsonQuery,
  getDbPath,
  buildFileInsertStatements,
  buildSymbolInsertStatements,
  ensureSqliteAvailable,
};
