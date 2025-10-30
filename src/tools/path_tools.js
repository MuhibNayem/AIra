import path from 'path';
import { glob, hasMagic } from 'glob';
import { detectSystemInfo } from '../utils/system.js';

const DEFAULT_LIMIT = 20;

const resolveCwd = (cwd, systemInfo) => {
  if (!cwd) {
    return process.cwd();
  }
  return systemInfo.isWindows ? path.win32.resolve(cwd) : path.resolve(cwd);
};

const normalizeQuery = (query) => {
  if (!query || typeof query !== 'string') {
    throw new Error('resolvePath requires a non-empty "query" string.');
  }
  return query.trim();
};

const rankMatches = (matches) => {
  const scored = matches.map((match) => {
    const segments = match.split(path.sep).length;
    return { match, score: segments };
  });
  return scored.sort((a, b) => a.score - b.score).map((entry) => entry.match);
};

/**
 * Finds absolute paths in the project that match the supplied query.
 * @param {{ query: string, cwd?: string, limit?: number }} params
 * @returns {Promise<string>} JSON string describing matches.
 */
export const resolveProjectPath = async (params = {}) => {
  const systemInfo = detectSystemInfo();
  const rawQuery = normalizeQuery(params.query);
  const cwd = resolveCwd(params.cwd, systemInfo);
  const numericLimit = Number(params.limit);
  const limit = Number.isFinite(numericLimit) && numericLimit > 0 ? numericLimit : DEFAULT_LIMIT;

  const normalizedQuery = hasMagic(rawQuery)
    ? rawQuery
    : rawQuery.includes('/') || rawQuery.includes('\\')
      ? rawQuery
      : `**/${rawQuery}`;

  const matches = await glob(normalizedQuery, {
    cwd,
    absolute: true,
    nocase: systemInfo.isWindows,
    dot: true,
  });

  const unique = Array.from(new Set(rankMatches(matches)));
  const limited = unique.slice(0, limit);

  return JSON.stringify(
    {
      query: rawQuery,
      pattern: normalizedQuery,
      cwd,
      count: unique.length,
      matches: limited,
    },
    null,
    2,
  );
};
