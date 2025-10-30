import { exec } from 'child_process';
import util from 'util';
import { detectSystemInfo } from '../utils/system.js';

const execPromise = util.promisify(exec);
const DEFAULT_MAX_BUFFER = 1024 * 1024 * 10; // 10 MB
const WINDOWS_ALIAS_MAP = {
  ls: ({ args }) => {
    const switches = [];
    const paths = [];
    args.forEach((arg) => {
      if (arg.startsWith('-')) {
        if (arg.includes('a')) {
          switches.push('/a');
        }
        if (arg.includes('s')) {
          switches.push('/s');
        }
      } else {
        paths.push(arg);
      }
    });
    const distinctSwitches = [...new Set(switches)];
    return ['dir', ...distinctSwitches, ...paths].join(' ');
  },
  pwd: () => 'cd',
  clear: () => 'cls',
};

const tokenizeCommand = (command) => {
  const tokens = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if ((char === '"' || char === "'") && (!inQuotes || char === quoteChar)) {
      if (inQuotes && char === quoteChar) {
        inQuotes = false;
        quoteChar = '';
      } else if (!inQuotes) {
        inQuotes = true;
        quoteChar = char;
      }
      current += char;
      continue;
    }

    if (!inQuotes && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
};

const normalizeCommand = (command, systemInfo) => {
  if (!command || !systemInfo.isWindows) {
    return command;
  }

  const tokens = tokenizeCommand(command.trim());
  if (!tokens.length) {
    return command;
  }

  const [head, ...rest] = tokens;
  const normalizer = WINDOWS_ALIAS_MAP[head];
  if (!normalizer) {
    return command;
  }

  return normalizer({ args: rest });
};

const resolveCommandInput = (raw) => {
  if (raw === null || raw === undefined) {
    throw new Error('runShellCommand expects a string command.');
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error('runShellCommand expects a non-empty command.');
    }
    return trimmed;
  }

  if (typeof raw === 'object') {
    const candidate =
      typeof raw.command === 'string'
        ? raw.command
        : typeof raw.input === 'string'
          ? raw.input
          : undefined;
    if (!candidate) {
      throw new Error('runShellCommand expects a string command.');
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      throw new Error('runShellCommand expects a non-empty command.');
    }
    return trimmed;
  }

  throw new Error('runShellCommand expects a string command.');
};

/**
 * Executes a shell command.
 * @param {string} command The command to execute.
 * @param {object} [options] Optional exec options.
 * @returns {Promise<string>} The stdout and stderr of the command.
 */
export const runShellCommand = async (command, options = {}, systemInfo = detectSystemInfo()) => {
  if (!command || typeof command !== 'string') {
    throw new Error('runShellCommand expects a string command.');
  }

  const normalized = normalizeCommand(command, systemInfo);

  const defaultOptions = {
    maxBuffer: DEFAULT_MAX_BUFFER,
    ...options,
  };

  try {
    const { stdout, stderr } = await execPromise(normalized, defaultOptions);
    const stdoutClean = stdout?.trim();
    const stderrClean = stderr?.trim();

    if (stderrClean && !stdoutClean) {
      return `stderr:\n${stderrClean}`;
    }

    if (stderrClean && stdoutClean) {
      return `stdout:\n${stdoutClean}\n\nstderr:\n${stderrClean}`;
    }

    return stdoutClean || 'Command completed with no output.';
  } catch (error) {
    const stderrClean = error.stderr?.trim();
    const stdoutClean = error.stdout?.trim();
    return [
      `Command failed: ${error.message}`,
      stdoutClean ? `stdout:\n${stdoutClean}` : undefined,
      stderrClean ? `stderr:\n${stderrClean}` : undefined,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
};

/**
 * Factory that returns a shell command tool bound to the current system.
 * @param {ReturnType<typeof detectSystemInfo>} [systemInfo]
 * @returns {(input: string) => Promise<string>}
 */
export const createShellTool = (systemInfo = detectSystemInfo()) => {
  const execOptions = systemInfo.isWindows
    ? { shell: process.env.COMSPEC || 'C:\\\\Windows\\\\System32\\\\cmd.exe' }
    : { shell: process.env.SHELL || '/bin/bash' };

  return async (rawInput) => {
    const command = resolveCommandInput(rawInput);
    return runShellCommand(command, execOptions, systemInfo);
  };
};
