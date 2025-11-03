import { promises as fs } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { createLogger } from '../utils/logger.js';
import { telemetry } from '../utils/telemetry.js';
import {
  initializeMetadata,
  readMetadata,
  writeMetadata,
  getDefaultIndexConfig,
  createDefaultMetadata,
  __internals,
} from './metadata.js';
import { scanProjectFiles, detectLanguage } from './scanner.js';
import {
  ensureSchema as ensureSqliteSchema,
  recordFileScan,
  upsertSymbols,
} from './storage/sqlite.js';
import { extractSymbols, isLanguageSupported } from './parsers/index.js';

import { serializeRelationsForSymbol } from './parsers/normalizer.js';
import { createHash } from 'crypto';
import { getFaissVectorStore } from '../vector_store/faiss.js';
import { getDocumentsForFile } from '../vector_store/document_loader.js';
import { __internals as sqliteStorageInternals } from './storage/sqlite.js';


const indexLogger = createLogger('Indexer');

const toMilliseconds = (startedAt) =>
  Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

const renderJSON = (payload) => {
  console.log(JSON.stringify(payload, null, 2));
};

const resolveTargetCwd = (options = {}) => {
  if (options && typeof options.cwd === 'string' && options.cwd.trim()) {
    return path.resolve(options.cwd.trim());
  }
  return process.cwd();
};

const logProgress = (message) => {
  console.log(chalk.gray(message));
};

const renderStatus = (metadata) => {
  console.log(chalk.bold('Index Status'));
  console.log(`  Schema Version : ${metadata.schemaVersion}`);
  console.log(`  Created At     : ${metadata.createdAt}`);
  console.log(`  Updated At     : ${metadata.updatedAt}`);
  console.log(`  Files Indexed  : ${metadata.filesIndexed}`);
  console.log(
    `  Languages      : ${metadata.languages?.length ? metadata.languages.join(', ') : 'none'}`,
  );
  console.log(`  State          : ${metadata.state ?? 'unknown'}`);
  if (metadata.notes) {
    console.log(`  Notes          : ${metadata.notes}`);
  }
  if (metadata.lastCommand) {
    console.log('  Last Command   :');
    console.log(`    type   : ${metadata.lastCommand.type}`);
    console.log(`    at     : ${metadata.lastCommand.at}`);
    if (metadata.lastCommand.options && Object.keys(metadata.lastCommand.options).length) {
      console.log(`    options: ${JSON.stringify(metadata.lastCommand.options)}`);
    }
  }
  if (metadata.lastScan) {
    console.log('  Last Scan      :');
    console.log(`    at            : ${metadata.lastScan.at}`);
    if (metadata.lastScan.cwd) {
      console.log(`    cwd           : ${metadata.lastScan.cwd}`);
    }
    console.log(`    totalFiles    : ${metadata.lastScan.totalFiles ?? 0}`);
    if (metadata.lastScan.durationMs !== undefined) {
      console.log(`    durationMs    : ${metadata.lastScan.durationMs}`);
    }
    if (Array.isArray(metadata.lastScan.extensions) && metadata.lastScan.extensions.length) {
      console.log(`    extensions    : ${metadata.lastScan.extensions.join(', ')}`);
    }
    if (metadata.lastScan.pattern) {
      console.log(`    pattern       : ${metadata.lastScan.pattern}`);
    }
    if (metadata.lastScan.countsByLanguage) {
      console.log(
        `    countsByLang  : ${JSON.stringify(metadata.lastScan.countsByLanguage)}`,
      );
    }
    if (metadata.lastScan.countsByExtension) {
      console.log(
        `    countsByExt   : ${JSON.stringify(metadata.lastScan.countsByExtension)}`,
      );
    }
  }
};

const markReadyParsers = (metadata, readySet) => {
  if (!metadata || !metadata.parsers || !readySet?.size) {
    return;
  }
  readySet.forEach((language) => {
    if (!language) {
      return;
    }
    const key = `${language}`.toLowerCase();
    if (metadata.parsers[key]) {
      metadata.parsers[key] = {
        ...metadata.parsers[key],
        status: 'ready',
      };
    }
  });
};

const handleIndexVectors = async (options) => {
  const targetCwd = resolveTargetCwd(options);
  const indexRoot = __internals.resolveIndexRoot(targetCwd);
  await ensureSqliteSchema(indexRoot);
  const dbPath = sqliteStorageInternals.getDbPath(indexRoot);
  const chromaVectorStore = await getFaissVectorStore();

  logProgress('Scanning project files for vector indexing...');
  const { files } = await scanProjectFiles({ cwd: targetCwd });

  for (const filePath of files) {
    const relativeFilePath = path.relative(targetCwd, filePath);
    logProgress(`Processing ${relativeFilePath}`);

    let fileContent;
    try {
      fileContent = await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      indexLogger.error(`Failed to read file ${filePath}: ${error.message}`);
      continue;
    }

    const fileHash = createHash('sha256').update(fileContent).digest('hex');

    const existingHashRows = await sqliteStorageInternals.runJsonQuery(dbPath, `SELECT hash FROM file_hashes WHERE file_path = '${filePath}'`);
    const existingHashRow = existingHashRows[0];

    if (existingHashRow && existingHashRow.hash === fileHash) {
      logProgress(`  Skipping ${relativeFilePath} (no changes detected)`);
      continue;
    }

    logProgress(`  Indexing ${relativeFilePath}...`);
    const documents = await getDocumentsForFile(filePath);

    if (documents.length > 0) {
      try {
        await chromaVectorStore.addDocuments(documents);
        await sqliteStorageInternals.runSqlScript(dbPath, [`REPLACE INTO file_hashes (file_path, hash) VALUES ('${filePath}', '${fileHash}')`]);
        logProgress(`  Successfully indexed ${documents.length} chunks from ${relativeFilePath}`);
      } catch (error) {
        indexLogger.error(`Failed to add documents from ${filePath} to Chroma: ${error.message}`);
      }
    } else {
      logProgress(`  No indexable documents found in ${relativeFilePath}`);
    }
  }

  logProgress('Vector indexing complete.');
  return { status: 'ok', exitCode: 0 };
};

const handleStatus = async (options = {}) => {
  const targetCwd = resolveTargetCwd(options);
  const metadata = await readMetadata(targetCwd);
  if (!metadata) {
    console.log(
      chalk.yellow(
        'No index metadata found. Run "aira index build" to initialize the local index scaffold.',
      ),
    );
    return { status: 'missing', exitCode: 0 };
  }
  renderStatus(metadata);
  return { status: 'ok', metadata, exitCode: 0 };
};

const handleConfig = async (options = {}) => {
  const targetCwd = resolveTargetCwd(options);
  const config = getDefaultIndexConfig(targetCwd);
  console.log(chalk.bold('Index Configuration (preview)'));
  renderJSON(config);
  return { status: 'ok', config, exitCode: 0 };
};

const normalizeExtensions = (rawExtensions) => {
  if (!rawExtensions) {
    return undefined;
  }
  if (Array.isArray(rawExtensions)) {
    return rawExtensions
      .flatMap((entry) => `${entry}`.split(','))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof rawExtensions === 'string') {
    return rawExtensions
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return undefined;
};

const handleBuild = async (options) => {
  const targetCwd = resolveTargetCwd(options);
  const requestedExtensions =
    normalizeExtensions(options.extensions ?? options.ext) ?? undefined;
  const scanStartedAt = process.hrtime.bigint();
  logProgress('Scanning project files...');
  const { files, summary } = await scanProjectFiles({
    cwd: targetCwd,
    extensions: requestedExtensions,
  });
  const scanDurationMs = Number((process.hrtime.bigint() - scanStartedAt) / 1_000_000n);
  const extensionSummary = Array.isArray(summary.extensions) && summary.extensions.length
    ? summary.extensions.join(', ')
    : 'default extensions';
  logProgress(`Scan complete: ${summary.totalFiles} files matched (${extensionSummary})`);
  const indexRoot = __internals.resolveIndexRoot(targetCwd);
  const fileEntries = files.map((filePath) => ({
    path: filePath,
    language: detectLanguage(filePath),
  }));
  const summaryWithDuration = {
    ...summary,
    durationMs: scanDurationMs,
  };

  const metadata = await readMetadata(targetCwd);
  const now = new Date().toISOString();
  const lastCommand = {
    type: 'build',
    at: now,
    options,
  };
  const lastScan = {
    at: now,
    cwd: targetCwd,
    totalFiles: summary.totalFiles,
    countsByLanguage: summary.countsByLanguage,
    countsByExtension: summary.countsByExtension,
    durationMs: scanDurationMs,
    pattern: summary.pattern,
    extensions: summary.extensions,
  };
  let scanRecord;
  try {
    logProgress('Persisting scan details to SQLite...');
    await ensureSqliteSchema(indexRoot);
    scanRecord = await recordFileScan({
      indexRoot,
      summary: summaryWithDuration,
      files: fileEntries,
      startedAt: now,
      completedAt: now,
    });
    lastScan.scanId = scanRecord.scanId;
  } catch (error) {
    indexLogger.error('Failed to persist scan details to SQLite.', {
      error: error instanceof Error ? error.message : String(error),
    });
    lastScan.error = error instanceof Error ? error.message : String(error);
  }

  const symbolResults = [];
  const symbolRelations = [];
  const symbolErrors = [];
  const symbolDiagnostics = [];
  const readyParsers = new Set();

  for (const entry of fileEntries) {
    const languageKey = entry.language ? entry.language.toLowerCase() : '';
    const parserSupported = isLanguageSupported(entry.language);
    try {
      logProgress(
        `Extracting symbols from ${path.relative(targetCwd, entry.path) || entry.path}`,
      );
      const symbolPayload = await extractSymbols({
        filePath: entry.path,
        language: entry.language,
      });
      if (parserSupported && languageKey) {
        readyParsers.add(languageKey);
      }
      const extractedSymbols = symbolPayload?.symbols ?? [];
      const extractedRelations = symbolPayload?.relations ?? [];
      const diagnostics = symbolPayload?.diagnostics ?? [];

      extractedSymbols.forEach((symbol) => {
        const metadataForSymbol = {
          location: symbol.location,
          detail: symbol.detail,
          properties: symbol.properties,
        };
        const relatedRelations = serializeRelationsForSymbol(
          symbol.id,
          extractedRelations,
        );
        if (relatedRelations.length) {
          metadataForSymbol.relations = relatedRelations;
        }
        symbolResults.push({
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.location?.start?.line ?? 0,
          signature: symbol.signature,
          filePath: entry.path,
          metadata: metadataForSymbol,
        });
      });

      if (extractedRelations.length) {
        symbolRelations.push(
          ...extractedRelations.map((relation) => ({
            ...relation,
            filePath: entry.path,
          })),
        );
      }

      if (diagnostics.length) {
        diagnostics.forEach((diagnostic) => {
          symbolDiagnostics.push({
            ...diagnostic,
            file: entry.path,
          });
          const locationSummary = diagnostic.location
            ? ` (line ${diagnostic.location.start.line})`
            : '';
          symbolErrors.push({
            file: entry.path,
            severity: diagnostic.severity ?? 'warning',
            message: `${diagnostic.message}${locationSummary}`,
          });
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      symbolErrors.push({ file: entry.path, severity: 'error', message });
    }
  }

  if (symbolErrors.length) {
    lastScan.symbolErrors = symbolErrors;
  }
  const diagnosticSnapshot = symbolDiagnostics.slice(0, 200);
  if (diagnosticSnapshot.length) {
    lastScan.symbolDiagnostics = diagnosticSnapshot;
  }
  const relationSnapshot = symbolRelations.slice(0, 1000);
  if (relationSnapshot.length) {
    lastScan.relations = relationSnapshot;
  }
  lastScan.relationCount = symbolRelations.length;
  lastScan.symbolCount = symbolResults.length;

  if (!metadata) {
    const result = await initializeMetadata({
      lastCommand,
      filesIndexed: summary.totalFiles,
      languages: summary.languages,
      state: summary.totalFiles ? 'scanned' : 'initialized',
      lastScan,
    }, targetCwd);
    const initializedMetadata = {
      ...result.metadata,
    };
    initializedMetadata.persistence = {
      ...initializedMetadata.persistence,
      metadata: {
        ...result.metadata.persistence.metadata,
        status: scanRecord ? 'ready' : 'pending',
        path: path.join(indexRoot, 'index.db'),
      },
    };
    initializedMetadata.artifacts = {
      metadataPath: __internals.resolveMetadataPath(targetCwd),
      indexRoot,
    };
    initializedMetadata.lastScan = {
      ...(initializedMetadata.lastScan || {}),
      ...lastScan,
      scanId: scanRecord?.scanId ?? initializedMetadata.lastScan?.scanId,
    };
    if (symbolResults.length && scanRecord?.scanId) {
      try {
        await upsertSymbols({
          indexRoot,
          scanId: scanRecord.scanId,
          symbols: symbolResults,
          fileIdMap: scanRecord.fileIdMap,
        });
        initializedMetadata.lastScan.symbolCount = symbolResults.length;
        initializedMetadata.lastScan.relationCount = symbolRelations.length;
        initializedMetadata.state = 'indexed';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        symbolErrors.push({ file: '<<bulk>>', severity: 'error', message });
      }
    }
    if (symbolErrors.length) {
      initializedMetadata.errors = (initializedMetadata.errors || []).concat(
        symbolErrors.map((entry) => ({
          at: now,
          message: `${entry.file}: ${entry.message}`,
          severity: entry.severity ?? 'warning',
        })),
      );
    }
    initializedMetadata.lastScan.symbolCount = symbolResults.length;
    initializedMetadata.lastScan.relationCount = symbolRelations.length;
    markReadyParsers(initializedMetadata, readyParsers);
    await writeMetadata(initializedMetadata, targetCwd);
    const storedMetadata = (await readMetadata(targetCwd)) ?? initializedMetadata;
    console.log(chalk.green('Index metadata initialized.'));
    console.log(`Stored at: ${__internals.resolveMetadataPath(targetCwd)}`);
    if (summary.totalFiles) {
      console.log(
        chalk.gray(
          `Scanned ${summary.totalFiles} files across ${summary.languages.length} languages in ${scanDurationMs} ms.`,
        ),
      );
    } else {
      console.log(chalk.gray(`No files matched pattern ${summary.pattern}.`));
    }
    return {
      status: 'initialized',
      metadata: storedMetadata,
      exitCode: 0,
      summary,
      files,
    };
  }

  const merged = {
    ...createDefaultMetadata({}, targetCwd),
    ...metadata,
    lastCommand,
    filesIndexed: summary.totalFiles,
    languages: summary.languages,
    state: summary.totalFiles ? 'scanned' : 'initialized',
    lastScan,
    notes:
      metadata.notes ??
      'Index scaffold ready. Update notes when symbol/embedding stages populate data.',
  };
  if (!Array.isArray(merged.errors)) {
    merged.errors = [];
  }
  if (lastScan.error) {
    merged.errors.push({
      at: now,
      message: lastScan.error,
      severity: 'error',
    });
  }
  if (symbolErrors.length) {
    symbolErrors.forEach((entry) => {
      merged.errors.push({
        at: now,
        message: `${entry.file}: ${entry.message}`,
        severity: entry.severity ?? 'warning',
      });
    });
  }
  merged.persistence.metadata = {
    ...merged.persistence.metadata,
    status: 'ready',
    path: path.join(indexRoot, 'index.db'),
  };
  merged.artifacts = {
    metadataPath: __internals.resolveMetadataPath(targetCwd),
    indexRoot,
  };
  merged.lastScan = {
    ...(merged.lastScan || {}),
    ...lastScan,
    scanId: scanRecord?.scanId ?? merged.lastScan?.scanId,
  };
  if (symbolResults.length && scanRecord?.scanId) {
    try {
      await upsertSymbols({
        indexRoot,
        scanId: scanRecord.scanId,
        symbols: symbolResults,
        fileIdMap: scanRecord.fileIdMap,
      });
      merged.state = 'indexed';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      merged.errors.push({
        at: now,
        message: `symbol-insert: ${message}`,
        severity: 'error',
      });
    }
  }
  merged.lastScan.symbolCount = symbolResults.length;
  merged.lastScan.relationCount = symbolRelations.length;
  merged.createdAt = metadata.createdAt ?? merged.createdAt;
  merged.updatedAt = now;

  markReadyParsers(merged, readyParsers);
  await writeMetadata(merged, targetCwd);
  const stored = await readMetadata(targetCwd);
  console.log(chalk.green('Index metadata refreshed.'));
  if (summary.totalFiles) {
    console.log(
      chalk.gray(
        `Scanned ${summary.totalFiles} files across ${summary.languages.length} languages in ${scanDurationMs} ms.`,
      ),
    );
  } else {
    console.log(chalk.gray(`No files matched pattern ${summary.pattern}.`));
  }
  return {
    status: 'updated',
    metadata: stored ?? merged,
    exitCode: 0,
    summary,
    files,
  };
};

const handlePrune = async (options = {}) => {
  const targetCwd = resolveTargetCwd(options);
  const indexRoot = __internals.resolveIndexRoot(targetCwd);
  try {
    await fs.rm(indexRoot, { recursive: true, force: true });
    console.log(chalk.green(`Index directory removed: ${indexRoot}`));
    return { status: 'removed', exitCode: 0 };
  } catch (error) {
    console.log(
      chalk.red(
        `Failed to prune index directory (${indexRoot}): ${error instanceof Error ? error.message : error}`,
      ),
    );
    return { status: 'error', exitCode: 1 };
  }
};

const renderPending = (command) => {
  console.log(
    chalk.yellow(
      `Index command "${command}" is not yet implemented. Track progress in docs/indexing-implementation-plan.md.`,
    ),
  );
  return { status: 'not_implemented' };
};

/**
 * Handles CLI index commands.
 * @param {{ command: string, options: Record<string, any>, positionals: string[], rawArgs: string[] }} params
 * @returns {Promise<{ status: string, exitCode?: number }>}
 */
export const handleIndexCommand = async (params = {}) => {
  const command = params.command || 'status';
  const options = params.options || {};
  const positionals = Array.isArray(params.positionals) ? params.positionals : [];
  const runId = `index-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = process.hrtime.bigint();

  indexLogger.info('Index command received.', {
    runId,
    command,
    options,
    positionals,
  });

  telemetry.write({
    type: 'index',
    phase: 'start',
    runId,
    command,
    options,
    positionals,
  });

  try {
    const result = await (async () => {
      switch (command) {
        case 'build':
          return handleBuild(options);
        case 'index-vectors':
          return handleIndexVectors(options);
        case 'status':
          return handleStatus(options);
        case 'config':
          return handleConfig(options);
        case 'prune':
          return handlePrune(options);
        case 'watch':
          return renderPending(command);
        default:
          console.log(chalk.red(`Unknown index subcommand: "${command}".`));
          return { status: 'invalid_command', exitCode: 1 };
      }
    })();

    telemetry.write({
      type: 'index',
      phase: 'complete',
      runId,
      command,
      status: result.status,
      durationMs: toMilliseconds(startedAt),
    });

    return result;
  } catch (error) {
    indexLogger.error('Index command failed.', { runId, command, error: error.message });
    telemetry.write({
      type: 'index',
      phase: 'error',
      runId,
      command,
      durationMs: toMilliseconds(startedAt),
      error: error.message,
    });
    console.error(
      chalk.red(`Index command "${command}" failed: ${error instanceof Error ? error.message : error}`),
    );
    return { status: 'error', exitCode: 1 };
  }
};
