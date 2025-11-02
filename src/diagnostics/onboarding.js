import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { EOL } from 'os';
import path from 'path';
import { promisify } from 'util';
import chalk from 'chalk';
import { detectSystemInfo } from '../utils/system.js';
import { telemetry } from '../utils/telemetry.js';

const execFileAsync = promisify(execFile);
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'qwen3:latest';
const STRIP_ANSI_REGEX = /\x1B\[[0-9;]*m/g;
const REQUIRED_ENV_VARS = [
  {
    name: 'OLLAMA_BASE_URL',
    remedy: 'Define OLLAMA_BASE_URL (e.g., http://localhost:11434) in your environment or .env file.',
  },
  {
    name: 'OLLAMA_MODEL',
    remedy: 'Define OLLAMA_MODEL (e.g., qwen3:latest) to control which model AIra loads.',
  },
];

const stripAnsi = (value = '') => value.replace(STRIP_ANSI_REGEX, '');
const defaultReportPath = () =>
  path.resolve(process.cwd(), 'reports', 'onboarding-report.txt');

const emitLine = (collector, silent, line = '') => {
  if (!silent) {
    console.log(line);
  }
  collector.push(stripAnsi(line));
};

const summarizeFailure = (command, error) => {
  const stdout = error?.stdout?.toString().trim();
  const stderr = error?.stderr?.toString().trim();
  const message = error?.message ?? 'Unknown failure.';
  return [
    `Command failed: ${command}`,
    message ? `Message: ${message}` : null,
    stdout ? `stdout:\n${stdout}` : null,
    stderr ? `stderr:\n${stderr}` : null,
  ]
    .filter(Boolean)
    .join('\n');
};

const runCommand = async (
  command,
  args = [],
  { timeout = 300000, verbose = false, logger } = {},
) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout,
      maxBuffer: 1024 * 1024 * 20,
    });
    const normalizedStdout = stdout?.toString().trim();
    const normalizedStderr = stderr?.toString().trim();

    if (verbose && typeof logger === 'function') {
      if (normalizedStdout) {
        logger(chalk.gray(`    stdout: ${normalizedStdout}`));
      }
      if (normalizedStderr) {
        logger(chalk.gray(`    stderr: ${normalizedStderr}`));
      }
    }

    return { ok: true, stdout: normalizedStdout, stderr: normalizedStderr };
  } catch (error) {
    return {
      ok: false,
      error,
      message: summarizeFailure(`${command} ${args.join(' ')}`.trim(), error),
    };
  }
};

const ensureReportDirectory = async (targetPath) => {
  const directory = path.dirname(targetPath);
  await fs.mkdir(directory, { recursive: true });
};

const writeReport = async ({ reportPath, lines, friction }) => {
  if (!reportPath) {
    return;
  }

  const contents = [
    `Run Timestamp: ${new Date().toISOString()}`,
    '',
    ...lines,
    '',
    'Recorded friction:',
    ...(friction.length
      ? friction.map(
          ({ message, remedy }, index) =>
            `${index + 1}. ${message}${remedy ? `${EOL}   Remedy: ${remedy}` : ''}`,
        )
      : ['None']),
    '',
  ].join(EOL);

  await ensureReportDirectory(reportPath);
  await fs.writeFile(reportPath, contents, 'utf-8');
  console.log(chalk.gray(`\nReport saved to ${reportPath}`));
};

const logSection = (collector, silent, title) => {
  emitLine(collector, silent, chalk.bold(`\n▶ ${title}`));
};

const recordFriction = (friction, collector, silent, message, remedy) => {
  friction.push({ message, remedy });
  emitLine(collector, silent, chalk.yellow(`  • ${message}`));
  if (remedy) {
    emitLine(collector, silent, chalk.gray(`    ↳ ${remedy}`));
  }
};

const checkOllamaAvailability = async (collector, friction, silent) => {
  logSection(collector, silent, 'Checking Ollama binary');
  const result = await runCommand('ollama', ['--version'], {
    logger: (line) => emitLine(collector, silent, line),
  });
  if (!result.ok) {
    recordFriction(
      friction,
      collector,
      silent,
      'Ollama CLI is not installed or not available on PATH.',
      'Install from https://ollama.com/download and retry.',
    );
    if (result.message) {
      emitLine(collector, silent, chalk.gray(`    ${result.message}`));
    }
    return false;
  }

  const versionLine = result.stdout?.split('\n')[0] ?? 'Detected Ollama.';
  emitLine(collector, silent, chalk.green(`  ✓ ${versionLine}`));
  return true;
};

const ensureModelPresent = async (collector, friction, silent, { autoFix, skipPull }) => {
  logSection(collector, silent, `Validating model availability (${DEFAULT_MODEL})`);
  const listResult = await runCommand('ollama', ['list'], {
    logger: (line) => emitLine(collector, silent, line),
  });
  if (!listResult.ok) {
    recordFriction(
      friction,
      collector,
      silent,
      'Unable to list local Ollama models.',
      'Ensure the Ollama daemon is running (ollama serve) and that you have access rights.',
    );
    if (listResult.message) {
      emitLine(collector, silent, chalk.gray(`    ${listResult.message}`));
    }
    return false;
  }

  const hasModel = listResult.stdout
    ?.toLowerCase()
    .includes(DEFAULT_MODEL.toLowerCase());
  if (hasModel) {
    emitLine(collector, silent, chalk.green(`  ✓ Model present: ${DEFAULT_MODEL}`));
    return true;
  }

  recordFriction(
    friction,
    collector,
    silent,
    `Model ${DEFAULT_MODEL} is not available locally.`,
    `Run "ollama pull ${DEFAULT_MODEL}".`,
  );

  if (!autoFix || skipPull) {
    emitLine(
      collector,
      silent,
      chalk.gray('  ○ Skipping automatic pull (run with --check --fix to attempt retrieval).'),
    );
    return false;
  }

  emitLine(
    collector,
    silent,
    chalk.gray(`  ○ Pulling ${DEFAULT_MODEL} … this may take a while.`),
  );
  const pullResult = await runCommand('ollama', ['pull', DEFAULT_MODEL], {
    verbose: true,
    timeout: 600000,
    logger: (line) => emitLine(collector, silent, line),
  });
  if (!pullResult.ok) {
    recordFriction(
      friction,
      collector,
      silent,
      `Automatic pull of ${DEFAULT_MODEL} failed.`,
      'Retry manually and verify network connectivity and available disk space.',
    );
    if (pullResult.message) {
      emitLine(collector, silent, chalk.gray(`    ${pullResult.message}`));
    }
    return false;
  }

  emitLine(collector, silent, chalk.green(`  ✓ Successfully pulled ${DEFAULT_MODEL}`));
  return true;
};

const runSelfCheck = async (collector, friction, silent, { autoFix, skipSelfCheck }) => {
  logSection(collector, silent, 'Running CLI smoke test');
  if (!autoFix || skipSelfCheck) {
    emitLine(
      collector,
      silent,
      chalk.gray(
        '  ○ Skipping CLI invocation (use --check --fix to trigger "aira --ask self-check").',
      ),
    );
    return;
  }

  const entryPoint = new URL('../index.js', import.meta.url).pathname;
  emitLine(collector, silent, chalk.gray('  ○ Executing: aira --ask "self-check"'));
  const result = await runCommand(process.execPath, [entryPoint, '--ask', 'self-check'], {
    verbose: true,
    timeout: 600000,
    logger: (line) => emitLine(collector, silent, line),
  });
  if (result.ok) {
    emitLine(collector, silent, chalk.green('  ✓ CLI self-check completed without error.'));
    return;
  }

  recordFriction(
    friction,
    collector,
    silent,
    'Running the CLI self-check failed.',
    'Inspect npm permissions, cached binaries, and ensure the package is published.',
  );
  if (result.message) {
    emitLine(collector, silent, chalk.gray(`    ${result.message}`));
  }
};

export const runDiagnostics = async ({
  autoFix = false,
  skipPull = false,
  skipSelfCheck = false,
  reportPath = defaultReportPath(),
  silent = false,
  context = 'onboarding',
} = {}) => {
  const startedAt = process.hrtime.bigint();
  const collector = [];
  const friction = [];
  let runErrorMessage;
  let success = false;

  try {
    const systemInfo = detectSystemInfo();
    emitLine(collector, silent, chalk.bold(`AIra Diagnostics (autoFix=${autoFix ? 'yes' : 'no'})`));
    emitLine(
      collector,
      silent,
      chalk.gray(`Environment: ${systemInfo.prettyName} | Shell: ${systemInfo.shell}`),
    );

    checkEnvironment(collector, friction, silent);
    const ollamaReady = await checkOllamaAvailability(collector, friction, silent);
    if (ollamaReady) {
      await ensureModelPresent(collector, friction, silent, { autoFix, skipPull });
    }
    await runSelfCheck(collector, friction, silent, { autoFix, skipSelfCheck });

    emitLine(collector, silent, chalk.bold('\nSummary'));
    if (friction.length) {
      friction.forEach(({ message }, index) => {
        emitLine(collector, silent, chalk.yellow(`  ${index + 1}. ${message}`));
      });
    } else {
      emitLine(collector, silent, chalk.green('  No friction detected.'));
    }

    try {
      await writeReport({ reportPath, lines: collector, friction });
    } catch (error) {
      emitLine(
        collector,
        silent,
        chalk.red(`Failed to write diagnostic report: ${error.message}`),
      );
    }

    success = friction.length === 0;

    return {
      friction,
      success,
      reportPath,
      lines: collector,
    };
  } catch (error) {
    runErrorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    telemetry.recordDiagnosticsRun({
      success,
      frictionCount: friction.length,
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      context,
      error: runErrorMessage,
    });
  }
};
const checkEnvironment = (collector, friction, silent) => {
  logSection(collector, silent, 'Checking environment variables');
  let allSet = true;
  REQUIRED_ENV_VARS.forEach(({ name, remedy }) => {
    const value = process.env[name];
    if (value === undefined || value === null || String(value).trim() === '') {
      recordFriction(
        friction,
        collector,
        silent,
        `Environment variable ${name} is not set.`,
        remedy,
      );
      allSet = false;
    } else {
      emitLine(collector, silent, chalk.green(`  ✓ ${name}=${value}`));
    }
  });
  if (allSet && !REQUIRED_ENV_VARS.length) {
    emitLine(collector, silent, chalk.green('  ✓ Required environment variables are set.'));
  }
};
