import { promises as fs } from 'fs';
import path from 'path';
import { glob, hasMagic } from 'glob';
import { detectSystemInfo } from '../utils/system.js';
import { IGNORED_GLOB_PATTERNS, isPathIgnored, filterIgnoredEntries } from '../utils/ignore.js';

const DEFAULT_LIMIT = 20;

const resolveCwd = (cwd, systemInfo) => {
  if (!cwd) {
    return process.cwd();
  }
  return systemInfo.isWindows ? path.win32.resolve(cwd) : path.resolve(cwd);
};

const splitQueries = (raw) => {
  if (!raw || typeof raw !== 'string') {
    throw new Error('resolvePath requires a non-empty "query" string.');
  }
  return raw
    .split(/(?:\s+OR\s+|,)/i)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const normalizeQuery = (query) => query.trim();

const rankMatches = (matches) =>
  matches
    .map((match) => ({
      match,
      score: match.split(path.sep).length,
    }))
    .sort((a, b) => a.score - b.score);

/**
 * Finds absolute paths in the project that match the supplied query.
 * @param {{ query: string, cwd?: string, limit?: number }} params
 * @returns {Promise<string>} JSON string describing matches.
 */
export const resolveProjectPath = async (params = {}) => {
  const systemInfo = detectSystemInfo();
  const cwd = resolveCwd(params.cwd, systemInfo);
  const numericLimit = Number(params.limit);
  const limit = Number.isFinite(numericLimit) && numericLimit > 0 ? numericLimit : DEFAULT_LIMIT;

  const queryTokens = splitQueries(params.query);
  if (!queryTokens.length) {
    throw new Error('resolvePath requires a non-empty "query" string.');
  }

  const patternSummaries = [];
  const aggregateMatches = new Set();
  let fallbackListing;

  for (const token of queryTokens) {
    const normalizedQuery = hasMagic(token)
      ? token
      : token.includes('/') || token.includes('\\')
        ? token
        : `**/${token}`;

    const matches = await glob(normalizedQuery, {
      cwd,
      absolute: true,
      nocase: systemInfo.isWindows,
      dot: true,
      ignore: IGNORED_GLOB_PATTERNS,
    });

    const filtered = matches.filter((match) => !isPathIgnored(match));
    const ranked = rankMatches(filtered);
    ranked.forEach(({ match }) => aggregateMatches.add(match));

    patternSummaries.push({
      query: token,
      pattern: normalizedQuery,
      count: ranked.length,
      matches: ranked.slice(0, limit).map(({ match }) => match),
    });
  }

  const unique = Array.from(aggregateMatches);
  unique.sort((a, b) => a.length - b.length);
  const limited = unique.slice(0, limit);

  if (!unique.length) {
    try {
      const dirents = await fs.readdir(cwd, { withFileTypes: true });
      const filteredNames = filterIgnoredEntries(dirents.map((entry) => entry.name));
      const allowedNames = new Set(filteredNames);
      const entries = [];
      for (const entry of dirents) {
        if (!allowedNames.has(entry.name)) {
          continue;
        }
        const type = entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : 'other';
        entries.push({ name: entry.name, type });
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      fallbackListing = {
        entries: entries.slice(0, limit),
        total: entries.length,
        truncated: entries.length > limit,
      };
    } catch (error) {
      fallbackListing = {
        error: `Failed to list directory entries: ${error.message}`,
      };
    }
  }

  return JSON.stringify(
    {
      cwd,
      queries: patternSummaries,
      count: unique.length,
      matches: limited,
      fallback: fallbackListing ?? null,
    },
    null,
    2,
  );
};
