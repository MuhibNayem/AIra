import { promises as fs } from 'fs';
import path from 'path';
import { glob } from 'glob';
import { detectSystemInfo } from '../utils/system.js';
import { IGNORED_GLOB_PATTERNS, filterIgnoredEntries, isPathIgnored } from '../utils/ignore.js';
import { ensureReadAllowed, ensureWriteAllowed } from '../utils/security.js';

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
  if (existsDirect && !isPathIgnored(direct)) {
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
    ignore: IGNORED_GLOB_PATTERNS,
  });

  const viable = [];
  for (const match of matches) {
    try {
      const stats = await fs.stat(match);
      if (
        !isPathIgnored(match) &&
        ((type === 'file' && stats.isFile()) || (type === 'directory' && stats.isDirectory()))
      ) {
        viable.push(match);
      }
    } catch (_) {

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
    ensureReadAllowed(resolvedPath);
    if (isPathIgnored(resolvedPath)) {
      return `Access to ${resolvedPath} is blocked because it resides in an ignored directory.`;
    }
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
          ensureReadAllowed(fallback);
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
 * Reads multiple files recursively from a root directory.
 * Respects ignore patterns and security restrictions.
 * @param {string} rootPath The root directory to start reading from.
 * @param {Object} options Configuration options.
 * @param {string[]} options.extensions File extensions to include (e.g., ['.js', '.ts']). If empty, includes all files.
 * @param {number} options.maxFiles Maximum number of files to read (default: 100).
 * @param {number} options.maxDepth Maximum directory depth to traverse (default: 10).
 * @param {boolean} options.includeContent Whether to include file content or just paths (default: true).
 * @returns {Promise<Object>} Object with success status, files array, and metadata.
 */
export const readManyFiles = async (rootPath, options = {}) => {
  const {
    extensions = [],
    maxFiles = 100,
    maxDepth = 10,
    includeContent = true,
  } = options;

  const results = {
    success: true,
    rootPath: '',
    filesRead: 0,
    filesSkipped: 0,
    errors: [],
    files: [],
  };

  try {
    const systemInfo = detectSystemInfo();
    const resolvedRoot = resolvePathForOS(rootPath || '.', systemInfo);

    // Check if root exists and is accessible
    if (!await directoryExists(resolvedRoot)) {
      const fallback = await attemptResolveExistingPath(rootPath || '.', { type: 'directory' });
      if (fallback) {
        results.rootPath = fallback;
      } else {
        results.success = false;
        results.errors.push(`Root directory not found: ${rootPath}`);
        return results;
      }
    } else {
      results.rootPath = resolvedRoot;
    }

    ensureReadAllowed(results.rootPath);

    if (isPathIgnored(results.rootPath)) {
      results.success = false;
      results.errors.push('Root directory is in an ignored path');
      return results;
    }

    // Build glob pattern for extensions
    let pattern = '**/*';
    if (extensions.length > 0) {
      const extPattern = extensions.length === 1
        ? extensions[0].replace(/^\./, '')
        : `{${extensions.map(ext => ext.replace(/^\./, '')).join(',')}}`;
      pattern = `**/*.${extPattern}`;
    }

    // Find all matching files
    const matches = await glob(pattern, {
      cwd: results.rootPath,
      absolute: true,
      nocase: systemInfo.isWindows,
      dot: false, // Don't include hidden files by default
      ignore: IGNORED_GLOB_PATTERNS,
      maxDepth,
    });

    // Process each file
    for (const filePath of matches) {
      // Stop if we've reached the limit
      if (results.filesRead >= maxFiles) {
        results.errors.push(`Reached maximum file limit (${maxFiles}). Some files were not read.`);
        break;
      }

      try {
        // Check if path is ignored
        if (isPathIgnored(filePath)) {
          results.filesSkipped++;
          continue;
        }

        // Verify it's a file
        const stats = await fs.stat(filePath);
        if (!stats.isFile()) {
          results.filesSkipped++;
          continue;
        }

        // Check security
        try {
          ensureReadAllowed(filePath);
        } catch (securityError) {
          results.filesSkipped++;
          results.errors.push(`Security: ${filePath} - ${securityError.message}`);
          continue;
        }

        // Read file content if requested
        let content = null;
        if (includeContent) {
          try {
            content = await fs.readFile(filePath, ENCODING);
          } catch (readError) {
            results.errors.push(`Read error: ${filePath} - ${readError.message}`);
            results.filesSkipped++;
            continue;
          }
        }

        // Calculate relative path
        const relativePath = path.relative(results.rootPath, filePath);

        // Add to results
        results.files.push({
          path: filePath,
          relativePath,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          content: includeContent ? content : undefined,
        });

        results.filesRead++;
      } catch (error) {
        results.errors.push(`Processing error: ${filePath} - ${error.message}`);
        results.filesSkipped++;
      }
    }

    return results;
  } catch (error) {
    results.success = false;
    results.errors.push(`Fatal error: ${error.message}`);
    return results;
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
    ensureWriteAllowed(resolvedPath);
    if (isPathIgnored(resolvedPath)) {
      return 'Error writing to file: target path is inside an ignored directory.';
    }
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
  if (!isPathIgnored(direct) && (await fileExists(direct))) {
    ensureReadAllowed(direct);
    return direct;
  }

  const fallback = await attemptResolveExistingPath(filePath, { type: 'file' });
  if (fallback) {
    ensureReadAllowed(fallback);
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
        ensureReadAllowed(fallback);
        directoryToRead = fallback;
      }
    }
    ensureReadAllowed(directoryToRead);
    if (isPathIgnored(directoryToRead)) {
      return 'Access to this directory is blocked because it resides in an ignored path.';
    }
    const entries = await fs.readdir(directoryToRead);
    return filterIgnoredEntries(entries);
  } catch (error) {
    return `Error listing directory: ${error.message}`;
  }
};

/**
 * Creates multiple files and directories from a given structure definition.
 * Automatically ensures directories exist and writes UTF-8 text to each file.
 * OS independent (works across Windows, macOS, Linux).
 *
 * @param {string} rootPath - The root directory where files will be created.
 * @param {Object[]} structure - Array of file or directory definitions:
 *   Example:
 *   [
 *     { path: 'src/index.js', content: 'console.log("Hello")' },
 *     { path: 'src/components/App.svelte', content: '<script></script>' },
 *     { path: 'public', isDirectory: true }
 *   ]
 * @returns {Promise<Object>} Result object with success status and logs.
 */
export const createManyFiles = async (rootPath, structure = []) => {
  const results = {
    success: true,
    rootPath: '',
    createdFiles: 0,
    createdDirs: 0,
    errors: [],
    logs: [],
  };

  try {
    const systemInfo = detectSystemInfo();
    const resolvedRoot = resolvePathForOS(rootPath, systemInfo);
    results.rootPath = resolvedRoot;

    ensureWriteAllowed(resolvedRoot);
    await fs.mkdir(resolvedRoot, { recursive: true });

    for (const entry of structure) {
      try {
        if (!entry || !entry.path) {
          results.errors.push('Invalid entry: missing "path" field.');
          continue;
        }

        const resolvedPath = resolvePathForOS(
          path.join(resolvedRoot, entry.path),
          systemInfo
        );

        // Skip ignored paths
        if (isPathIgnored(resolvedPath)) {
          results.logs.push(`Skipped ignored path: ${resolvedPath}`);
          continue;
        }

        // Create directory
        if (entry.isDirectory) {
          await fs.mkdir(resolvedPath, { recursive: true });
          results.logs.push(`Created directory: ${resolvedPath}`);
          results.createdDirs++;
          continue;
        }

        // Create file
        ensureWriteAllowed(resolvedPath);
        await ensureParentDirectory(resolvedPath);

        const content =
          typeof entry.content === 'string' ? entry.content : '';
        await fs.writeFile(resolvedPath, content, ENCODING);

        results.logs.push(`Created file: ${resolvedPath}`);
        results.createdFiles++;
      } catch (error) {
        results.errors.push(
          `Error creating ${entry.path}: ${error.message}`
        );
        results.success = false;
      }
    }

    return results;
  } catch (error) {
    results.success = false;
    results.errors.push(`Fatal error: ${error.message}`);
    return results;
  }
};

/**
 * Recursively lists all directories and files in a given root path.
 * @param {string} rootPath The root directory to start listing from.
 * @returns {Promise<Object>} The directory structure object with success status, root path, and folder hierarchy.
 */
export const listDirectoryStructure = async (rootPath) => {
  const results = {
    success: true,
    rootPath: '',
    structure: [],
    errors: [],
  };

  try {
    const systemInfo = detectSystemInfo();
    const resolvedRoot = resolvePathForOS(rootPath || '.', systemInfo);
    results.rootPath = resolvedRoot;

    ensureReadAllowed(resolvedRoot);

    if (isPathIgnored(resolvedRoot)) {
      results.success = false;
      results.errors.push('Root directory is in an ignored path');
      return results;
    }

    const entries = await fs.readdir(resolvedRoot);
    const structure = await getDirectoryTree(resolvedRoot, entries);

    results.structure = structure;
    return results;
  } catch (error) {
    results.success = false;
    results.errors.push(`Error listing directory structure: ${error.message}`);
    return results;
  }
};

/**
 * Recursively builds a directory tree from a list of entries.
 * @param {string} directory The current directory path.
 * @param {string[]} entries The files and directories in the current directory.
 * @returns {Promise<Object[]>} An array of directory/file objects representing the tree.
 */
const getDirectoryTree = async (directory, entries) => {
  const tree = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry);
    try {
      const stats = await fs.stat(fullPath);

      const node = {
        name: entry,
        isDirectory: stats.isDirectory(),
        children: [],
      };

      if (stats.isDirectory()) {
        const subEntries = await fs.readdir(fullPath);
        node.children = await getDirectoryTree(fullPath, subEntries);
      }

      tree.push(node);
    } catch (error) {
      tree.push({ name: entry, error: error.message });
    }
  }

  return tree;
};
