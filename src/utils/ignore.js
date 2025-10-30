import path from 'path';

export const IGNORED_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  'dist',
  'build',
  '.idea',
  '.vscode',
]);

export const IGNORED_GLOB_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/.mypy_cache/**',
  '**/.pytest_cache/**',
  '**/dist/**',
  '**/build/**',
  '**/.idea/**',
  '**/.vscode/**',
];

export const isPathIgnored = (targetPath) => {
  if (!targetPath) {
    return false;
  }
  const segments = targetPath.split(path.sep);
  return segments.some((segment) => IGNORED_DIRECTORY_NAMES.has(segment));
};

export const filterIgnoredEntries = (entries) =>
  entries.filter((entry) => !IGNORED_DIRECTORY_NAMES.has(entry));
