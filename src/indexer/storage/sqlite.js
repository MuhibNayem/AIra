
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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

const getCurrentVersion = async (dbPath) => {
  const result = await runJsonQuery(dbPath, 'PRAGMA user_version');
  return result[0]?.user_version || 0;
};

const runMigrations = async (dbPath) => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const migrationsDir = path.resolve(__dirname, 'migrations');
  const files = await fs.readdir(migrationsDir);
  const migrationFiles = files.filter(f => f.endsWith('.js')).sort();

  let currentVersion = await getCurrentVersion(dbPath);

  for (const file of migrationFiles) {
    const version = parseInt(file.split('_')[0], 10);
    if (version > currentVersion) {
      const migration = await import(path.join(migrationsDir, file));
      if (migration.up) {
        await runSqlScript(dbPath, migration.up);
        await runSqlScript(dbPath, [`PRAGMA user_version = ${version}`]);
        currentVersion = version;
      }
    }
  }
};

export const ensureSchema = async (indexRoot) => {
  await fs.mkdir(indexRoot, { recursive: true });
  const dbPath = getDbPath(indexRoot);
  const dbExists = await fs.access(dbPath).then(() => true).catch(() => false);
  if (!dbExists) {
    await runSqlScript(dbPath, ['PRAGMA journal_mode=WAL']);
  }
  await runMigrations(dbPath);
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

const buildRelationInsertStatements = ({ relations, scanId, symbolIdMap }) => {
  const statements = [];
  relations.forEach(relation => {
    const sourceId = symbolIdMap[relation.sourceId];
    const targetId = symbolIdMap[relation.targetId];
    if (sourceId && targetId) {
      statements.push(
        `INSERT INTO relations (source_symbol_id, target_symbol_id, kind, scan_id)
         VALUES (${sourceId}, ${targetId}, '${escapeText(relation.kind)}', ${scanId})`
      );
    }
  });
  return statements;
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
    const fileInsertStatements = [
      'BEGIN',
      ...buildFileInsertStatements({
        files,
        scanId,
        indexedAt: end,
      }),
      'COMMIT',
    ];
    await runSqlScript(dbPath, fileInsertStatements);
  }

  const fileRows = await runJsonQuery(
    dbPath,
    `SELECT id, path FROM files WHERE last_scan_id = ${scanId}`,
  );
  const fileIdMap = {};
  const fileContentInsertStatements = [];
  for (const row of fileRows) {
    fileIdMap[row.path] = row.id;
    try {
      const content = await fs.readFile(row.path, 'utf-8');
      fileContentInsertStatements.push(
        `INSERT INTO file_contents (file_id, content) VALUES (${row.id}, '${escapeText(content)}')`,
      );
    } catch (error) {
      console.error(`Failed to read file content for FTS: ${row.path}, ${error.message}`);
    }
  }

  if (fileContentInsertStatements.length > 0) {
    await runSqlScript(dbPath, ['BEGIN', ...fileContentInsertStatements, 'COMMIT']);
  }

  return { scanId, fileIdMap };
};

export const listFiles = async (indexRoot, { readRoots = [] } = {}) => {
  const dbPath = getDbPath(indexRoot);
  let query = 'SELECT path, language, last_indexed_at AS lastIndexedAt, last_scan_id AS lastScanId FROM files';
  if (readRoots.length > 0) {
    const whereClauses = readRoots.map(root => `path LIKE '${escapeText(root)}%'`).join(' OR ');
    query += ` WHERE ${whereClauses}`;
  }
  query += ' ORDER BY path';
  return runJsonQuery(dbPath, query);
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

export const upsertRelations = async ({ indexRoot, scanId, relations = [], symbolIdMap = {} }) => {
  if (!Array.isArray(relations) || !relations.length) {
    return { inserted: 0 };
  }
  const dbPath = await ensureSchema(indexRoot);
  const statements = buildRelationInsertStatements({ relations, scanId, symbolIdMap });
  if (!statements.length) {
    return { inserted: 0 };
  }
  // For simplicity, we are not deleting old relations for now.
  // A more robust implementation would clear old relations for the given scan.
  await runSqlScript(dbPath, ['BEGIN', ...statements, 'COMMIT']);
  return { inserted: statements.length };
};


export const listSymbols = async (indexRoot, { limit = 200, readRoots = [], name, kind, filePath } = {}) => {
  const dbPath = getDbPath(indexRoot);
  let query = `SELECT s.id, f.path AS filePath, s.name, s.kind, s.signature, s.line, s.scan_id AS scanId
     FROM symbols s
     JOIN files f ON f.id = s.file_id`;
  const whereConditions = [];

  if (readRoots.length > 0) {
    const rootClauses = readRoots.map(root => `f.path LIKE '${escapeText(root)}%'`);
    whereConditions.push(`(${rootClauses.join(' OR ')})`);
  }
  if (name) {
    whereConditions.push(`s.name LIKE '${escapeText(name)}%'`);
  }
  if (kind) {
    whereConditions.push(`s.kind = '${escapeText(kind)}'`);
  }
  if (filePath) {
    whereConditions.push(`f.path = '${escapeText(filePath)}'`);
  }

  if (whereConditions.length > 0) {
    query += ` WHERE ${whereConditions.join(' AND ')}`;
  }

  query += ` ORDER BY s.id DESC LIMIT ${Math.max(1, Number(limit) || 200)}`;
  return runJsonQuery(dbPath, query);
};

export const listRelations = async (indexRoot, { limit = 200, readRoots = [], kind, sourceSymbolId, targetSymbolId } = {}) => {
  const dbPath = getDbPath(indexRoot);
  let query = `SELECT r.id, r.kind, r.source_symbol_id, r.target_symbol_id, r.scan_id
     FROM relations r
     JOIN symbols s ON s.id = r.source_symbol_id
     JOIN files f ON f.id = s.file_id`;
  const whereConditions = [];

  if (readRoots.length > 0) {
    const rootClauses = readRoots.map(root => `f.path LIKE '${escapeText(root)}%'`);
    whereConditions.push(`(${rootClauses.join(' OR ')})`);
  }
  if (kind) {
    whereConditions.push(`r.kind = '${escapeText(kind)}'`);
  }
  if (sourceSymbolId) {
    whereConditions.push(`r.source_symbol_id = ${Number(sourceSymbolId)}`);
  }
  if (targetSymbolId) {
    whereConditions.push(`r.target_symbol_id = ${Number(targetSymbolId)}`);
  }

  if (whereConditions.length > 0) {
    query += ` WHERE ${whereConditions.join(' AND ')}`;
  }

  query += ` ORDER BY r.id DESC LIMIT ${Math.max(1, Number(limit) || 200)}`;

  return runJsonQuery(dbPath, query);
};

export const getSymbolById = async (indexRoot, id, { readRoots = [] } = {}) => {
  const dbPath = getDbPath(indexRoot);
  let query = `SELECT s.id, f.path AS filePath, s.name, s.kind, s.signature, s.line, s.metadata, s.scan_id AS scanId
     FROM symbols s
     JOIN files f ON f.id = s.file_id
     WHERE s.id = ${Number(id)}`;

  if (readRoots.length > 0) {
    const whereClauses = readRoots.map(root => `f.path LIKE '${escapeText(root)}%'`).join(' OR ');
    query += ` AND (${whereClauses})`;
  }

  const results = await runJsonQuery(dbPath, query);
  return results[0] || null;
};

export const searchFileContent = async (indexRoot, { query, filePathPattern, language, readRoots = [], limit = 200 } = {}) => {
  const dbPath = getDbPath(indexRoot);
  let sqlQuery = `SELECT f.path, f.language FROM files f JOIN file_contents fc ON f.id = fc.file_id`;
  const whereConditions = [];

  if (query) {
    const requiresLiteral = /[^\w\s*]/.test(query);
    const normalizedQuery = requiresLiteral
      ? `"${query.replace(/"/g, '""')}"`
      : query;
    whereConditions.push(`fc.content MATCH '${escapeText(normalizedQuery)}'`);
  }
  if (filePathPattern) {
    whereConditions.push(`f.path LIKE '${escapeText(filePathPattern)}%'`);
  }
  if (language) {
    whereConditions.push(`f.language = '${escapeText(language)}'`);
  }
  if (readRoots.length > 0) {
    const rootClauses = readRoots.map(root => `f.path LIKE '${escapeText(root)}%'`);
    whereConditions.push(`(${rootClauses.join(' OR ')})`);
  }

  if (whereConditions.length > 0) {
    sqlQuery += ` WHERE ${whereConditions.join(' AND ')}`;
  }

  sqlQuery += ` LIMIT ${Math.max(1, Number(limit) || 200)}`;

  return runJsonQuery(dbPath, sqlQuery);
};

export const __internals = {
  runSqlScript,
  runJsonQuery,
  getDbPath,
  buildFileInsertStatements,
  buildSymbolInsertStatements,
  buildRelationInsertStatements,
  ensureSqliteAvailable,
  runMigrations,
  getCurrentVersion,
  getSymbolById,
  searchFileContent,
};
