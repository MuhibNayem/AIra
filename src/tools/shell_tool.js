import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);
const DEFAULT_MAX_BUFFER = 1024 * 1024 * 10; // 10 MB

/**
 * Executes a shell command.
 * @param {string} command The command to execute.
 * @param {object} [options] Optional exec options.
 * @returns {Promise<string>} The stdout and stderr of the command.
 */
export const runShellCommand = async (command, options = {}) => {
  if (!command || typeof command !== 'string') {
    throw new Error('runShellCommand expects a string command.');
  }

  try {
    const { stdout, stderr } = await execPromise(command, {
      maxBuffer: DEFAULT_MAX_BUFFER,
      ...options,
    });
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
