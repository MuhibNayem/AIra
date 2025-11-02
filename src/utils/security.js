import path from 'path';
import readline from 'readline';

const DEFAULT_SHELL_BLOCKLIST = [
  'rm',
  'mv',
  'rmdir',
  'dd',
  'mkfs',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'chmod',
  'chown',
  'userdel',
  'groupdel',
  'kill',
  'killall',
  'pkill',
  'sudo',
  'service',
  'systemctl',
  'diskpart',
  'format',
  'del',
  'erase',
];

const parseList = (value) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

const normalizeCommand = (command) => (command || '').trim().toLowerCase();

const resolveRoots = (primary, additional, defaultRoots) => {
  const base = primary.length ? primary : defaultRoots;
  const combined = [...base, ...additional].map((entry) => path.resolve(entry));
  const unique = [];
  const seen = new Set();
  combined.forEach((entry) => {
    if (!seen.has(entry)) {
      seen.add(entry);
      unique.push(entry);
    }
  });
  return unique;
};

const isPathInsideRoot = (target, root) => {
  const relative = path.relative(root, target);
  if (!relative) {
    return true;
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  return true;
};

const getResolvedPath = (value) => path.resolve(value);

const commandHead = (command) => {
  const trimmed = (command || '').trim();
  if (!trimmed) {
    return '';
  }
  const parts = trimmed.split(/\s+/);
  return parts[0] || '';
};

export const isFilesystemReadOnly = () =>
  process.env.AIRA_FS_READONLY === '1' || process.env.AIRA_FS_READONLY === 'true';

export const getAllowedWriteRoots = () => {
  const primary = parseList(process.env.AIRA_FS_WRITE_ROOTS);
  const additional = parseList(process.env.AIRA_FS_ADDITIONAL_WRITE_ROOTS);
  return resolveRoots(primary, additional, [process.cwd()]);
};

export const getAllowedReadRoots = () => {
  const primary = parseList(process.env.AIRA_FS_READ_ROOTS);
  const additional = parseList(process.env.AIRA_FS_ADDITIONAL_READ_ROOTS);
  return resolveRoots(primary, additional, [process.cwd()]);
};

export const ensureReadAllowed = (targetPath) => {
  const normalized = getResolvedPath(targetPath);
  const roots = getAllowedReadRoots();
  if (!roots.some((root) => isPathInsideRoot(normalized, root))) {
    throw new Error(
      `Read blocked: ${normalized} is outside allowed paths. Configure AIRA_FS_READ_ROOTS to extend access.`,
    );
  }
};

export const ensureWriteAllowed = (targetPath) => {
  if (isFilesystemReadOnly()) {
    throw new Error('Write blocked: filesystem is in read-only mode (AIRA_FS_READONLY=1).');
  }
  const normalized = getResolvedPath(targetPath);
  const roots = getAllowedWriteRoots();
  if (!roots.some((root) => isPathInsideRoot(normalized, root))) {
    throw new Error(
      `Write blocked: ${normalized} is outside allowed roots. Configure AIRA_FS_WRITE_ROOTS or AIRA_FS_ADDITIONAL_WRITE_ROOTS.`,
    );
  }
};

const defaultShellBlockSet = new Set(DEFAULT_SHELL_BLOCKLIST.map(normalizeCommand));

const singleUseAllowances = new Set();
const sessionAllowances = new Set();

const shouldAllowFromOverrides = (head, fullCommand) => {
  if (sessionAllowances.has(head) || sessionAllowances.has(fullCommand)) {
    return true;
  }
  if (singleUseAllowances.has(fullCommand)) {
    singleUseAllowances.delete(fullCommand);
    return true;
  }
  return false;
};

const promptShellOverride = async ({ command, head }) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const ask = () =>
    new Promise((resolve) => {
      rl.question(
        `Command "${command}" is blocked by policy.\n` +
          'Choose an option:\n' +
          '  1) Allow this command once\n' +
          '  2) Allow for this session\n' +
          '  3) Do not allow (default)\n' +
          'Selection [3]: ',
        (answer) => resolve(answer.trim()),
      );
    });

  let choice;
  try {
    choice = await ask();
  } finally {
    rl.close();
  }

  const normalized = choice ? choice.trim().charAt(0) : '';

  if (normalized === '1') {
    singleUseAllowances.add(command);
    return { decision: 'once' };
  }
  if (normalized === '2') {
    sessionAllowances.add(head);
    sessionAllowances.add(command);
    return { decision: 'session' };
  }
  return { decision: 'deny' };
};

export const ensureShellCommandAllowed = async (
  command,
  { interactive = process.stdin.isTTY && process.stdout.isTTY } = {},
) => {
  const head = normalizeCommand(commandHead(command));
  if (!head) {
    return;
  }

  if (defaultShellBlockSet.has(head)) {
    if (shouldAllowFromOverrides(head, command)) {
      return;
    }
    if (interactive) {
      const { decision } = await promptShellOverride({ command, head });
      if (decision === 'deny') {
        throw new Error(`Shell command "${head}" denied by user.`);
      }
      return;
    }
    throw new Error(
      `Shell command "${head}" is blocked by policy. Re-run interactively to approve or choose an alternative.`,
    );
  }
};

export const resetSecurityOverrides = () => {
  singleUseAllowances.clear();
  sessionAllowances.clear();
};
