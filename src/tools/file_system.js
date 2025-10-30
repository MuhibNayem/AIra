import { promises as fs } from 'fs';
import path from 'path';
import { glob } from 'glob';
import { detectSystemInfo } from '../utils/system.js';

const ENCODING = 'utf-8';

export const resolvePathForOS = (targetPath, systemInfo = detectSystemInfo()) => {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('A non-empty file path string is required.');
  }
  const trimmed = targetPath.trim();
  if (!trimmed) {
    throw new Error('A non-empty file path string is required.');
  }
  return systemInfo.isWindows ? path.win32.resolve(trimmed) : path.resolve(trimmed);
};

const ensureParentDirectory = async (filePath) => {
  const directory = path.dirname(filePath);
  if (!directory) {
    return;
  }
  await fs.mkdir(directory, { recursive: true });
};

export const fileExists = async (filePath) => {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch (_) {
    return false;
  }
};

export const directoryExists = async (directoryPath) => {
  try {
    const stats = await fs.stat(directoryPath);
    return stats.isDirectory();
  } catch (_) {
    return false;
  }
};

export const attemptResolveExistingPath = async (originalPath, { type = 'file' } = {}) => {
  const systemInfo = detectSystemInfo();
  const cwd = process.cwd();
  const normalizedOriginal = originalPath?.trim() || '';
  if (!normalizedOriginal) {
    return null;
  }

  const direct = resolvePathForOS(normalizedOriginal, systemInfo);
  const existsDirect =
    type === 'file' ? await fileExists(direct) : await directoryExists(direct);
  if (existsDirect) {
    return direct;
  }

  const basename = path.basename(normalizedOriginal);
  const pattern =
    normalizedOriginal.includes(path.sep) || normalizedOriginal.includes('/')
      ? normalizedOriginal
      : `**/${basename}`;

  const matches = await glob(pattern, {
    cwd,
    absolute: true,
    nocase: systemInfo.isWindows,
    dot: true,
  });

  const viable = [];
  for (const match of matches) {
    try {
      const stats = await fs.stat(match);
      if ((type === 'file' && stats.isFile()) || (type === 'directory' && stats.isDirectory())) {
        viable.push(match);
      }
    } catch (_) {
      // ignore stale match
    }
  }

  if (!viable.length) {
    return null;
  }

  viable.sort((a, b) => a.length - b.length);
  return viable[0];
};

/**
 * Reads the content of a file with OS-aware path resolution.
 * @param {string} filePath The path to the file.
 * @returns {Promise<string>} The content or an error message.
 */
export const readFile = async (filePath) => {
  let resolvedPath = filePath;
  try {
    const systemInfo = detectSystemInfo();
    resolvedPath = resolvePathForOS(filePath, systemInfo);
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      return `Error reading file: ${resolvedPath} is not a regular file.`;
    }
    return await fs.readFile(resolvedPath, ENCODING);
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        const fallback = await attemptResolveExistingPath(filePath, { type: 'file' });
        if (fallback) {
          const content = await fs.readFile(fallback, ENCODING);
          return content;
        }
      } catch (fallbackError) {
        return `Error reading file: ${fallbackError.message}`;
      }
    }
    return `Error reading file: ${error.message}`;
  }
};

/**
 * Writes UTF-8 content to a file. Creates intermediate directories if necessary.
 * Ensures the file exists before writing to satisfy tooling expectations.
 * @param {string} filePath The path to the file.
 * @param {string} content The content to write.
 * @returns {Promise<string>} A confirmation or descriptive error message.
 */
export const writeFile = async (filePath, content) => {
  if (typeof content !== 'string') {
    return 'Error writing to file: content must be a UTF-8 string.';
  }

  let resolvedPath = filePath;
  try {
    const systemInfo = detectSystemInfo();
    resolvedPath = resolvePathForOS(filePath, systemInfo);
    await ensureParentDirectory(resolvedPath);

    const exists = await fileExists(resolvedPath);
    if (!exists) {
      const handle = await fs.open(resolvedPath, 'w');
      await handle.close();
    }
    await fs.writeFile(resolvedPath, content, ENCODING);

    return exists
      ? `Successfully overwrote ${resolvedPath}`
      : `Successfully created ${resolvedPath}`;
  } catch (error) {
    return `Error writing to file: ${error.message}`;
  }
};

/**
 * Resolves a file path to an existing absolute path or throws if none found.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export const resolveFilePath = async (filePath) => {
  const systemInfo = detectSystemInfo();
  const direct = resolvePathForOS(filePath, systemInfo);
  if (await fileExists(direct)) {
    return direct;
  }

  const fallback = await attemptResolveExistingPath(filePath, { type: 'file' });
  if (fallback) {
    return fallback;
  }

  throw new Error(`File not found: ${filePath}`);
};

/**
 * Lists the files and directories in a given path.
 * @param {string} directoryPath The path to the directory.
 * @returns {Promise<string[]|string>} A list of entries or an error message.
 */
export const listDirectory = async (directoryPath) => {
  let resolvedPath = directoryPath;
  try {
    const systemInfo = detectSystemInfo();
    resolvedPath = resolvePathForOS(directoryPath || '.', systemInfo);
    let directoryToRead = resolvedPath;
    const exists = await directoryExists(resolvedPath);
    if (!exists) {
      const fallback = await attemptResolveExistingPath(directoryPath || '.', {
        type: 'directory',
      });
      if (fallback) {
        directoryToRead = fallback;
      }
    }
    const entries = await fs.readdir(directoryToRead);
    return entries;
  } catch (error) {
    return `Error listing directory: ${error.message}`;
  }
};
