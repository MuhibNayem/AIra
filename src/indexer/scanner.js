import path from 'path';
import { glob } from 'glob';
import { IGNORED_GLOB_PATTERNS, isPathIgnored } from '../utils/ignore.js';

const DEFAULT_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.java'];

const EXTENSION_LANGUAGE_MAP = new Map([
  ['js', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['jsx', 'javascript'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['py', 'python'],
  ['java', 'java'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['rb', 'ruby'],
  ['php', 'php'],
  ['cs', 'csharp'],
  ['cpp', 'cpp'],
  ['cc', 'cpp'],
  ['c', 'c'],
  ['swift', 'swift'],
  ['kt', 'kotlin'],
  ['kts', 'kotlin'],
  ['scala', 'scala'],
  ['fs', 'fsharp'],
  ['fsx', 'fsharp'],
]);

const sanitizeExtension = (value) =>
  (value || '')
    .toString()
    .trim()
    .replace(/^\./, '')
    .toLowerCase();

const buildPattern = (extensions) => {
  const sanitized = Array.from(extensions)
    .map(sanitizeExtension)
    .filter(Boolean);
  if (!sanitized.length) {
    sanitized.push(...DEFAULT_EXTENSIONS.map((ext) => sanitizeExtension(ext)));
  }

  const unique = Array.from(new Set(sanitized));
  if (unique.length === 1) {
    return `**/*.${unique[0]}`;
  }
  return `**/*.{${unique.join(',')}}`;
};

const detectLanguageForExtension = (extension) => {
  const normalized = sanitizeExtension(extension);
  return EXTENSION_LANGUAGE_MAP.get(normalized) ?? 'unknown';
};

const detectLanguageForFile = (filePath) => {
  const ext = sanitizeExtension(path.extname(filePath));
  return detectLanguageForExtension(ext);
};

export const scanProjectFiles = async ({
  cwd = process.cwd(),
  extensions = DEFAULT_EXTENSIONS,
} = {}) => {
  const extensionSet = new Set(
    Array.isArray(extensions) ? extensions : `${extensions}`.split(','),
  );
  const pattern = buildPattern(extensionSet);
  const matches = await glob(pattern, {
    cwd,
    absolute: true,
    nodir: true,
    ignore: IGNORED_GLOB_PATTERNS,
  });

  const files = matches.filter((file) => !isPathIgnored(file));
  const countsByExtension = {};
  const countsByLanguage = {};

  files.forEach((file) => {
    const extension = sanitizeExtension(path.extname(file));
    const language = detectLanguageForFile(file);

    countsByExtension[extension || ''] =
      (countsByExtension[extension || ''] ?? 0) + 1;
    if (language !== 'unknown') {
      countsByLanguage[language] = (countsByLanguage[language] ?? 0) + 1;
    }
  });

  const summary = {
    totalFiles: files.length,
    countsByExtension,
    countsByLanguage,
    languages: Object.keys(countsByLanguage),
    extensions: Array.from(extensionSet).map((ext) =>
      ext.startsWith('.') ? ext : `.${ext}`,
    ),
    pattern,
  };

  return { files, summary };
};

export const detectLanguage = detectLanguageForFile;

export const __internals = {
  DEFAULT_EXTENSIONS,
  EXTENSION_LANGUAGE_MAP,
  buildPattern,
  detectLanguageForExtension,
};
