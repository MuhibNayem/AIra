import readline from 'readline';
import 'dotenv/config';
import { DynamicTool } from '@langchain/core/tools';
import { ollama } from './llms/ollama.js';
import { readFile, writeFile, listDirectory } from './tools/file_system.js';
import { runShellCommand } from './tools/shell_tool.js';
import { searchFileContent } from './tools/code_tools.js';
import { createRefactorChain } from './chains/refactor_chain.js';
import { buildCodeAgent } from './agents/code_agent.js';
import { logger } from './utils/logger.js';

const EXIT_COMMANDS = new Set(['exit', 'quit', 'q']);

const safeJsonParse = (raw, toolName) => {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${toolName} expects a JSON string. Received: ${raw}. Parse error: ${error.message}`,
    );
  }
};

const buildTooling = (refactorChain) => [
  new DynamicTool({
    name: 'readFile',
    description: 'Reads the content of a UTF-8 text file. Input should be a filepath string.',
    func: readFile,
  }),
  new DynamicTool({
    name: 'writeFile',
    description:
      'Writes UTF-8 content to a file. Input should be a JSON string: { "path": "<path>", "content": "<text>" }.',
    func: async (rawInput) => {
      const { path, content } = safeJsonParse(rawInput, 'writeFile');
      if (!path || typeof content !== 'string') {
        throw new Error('writeFile requires JSON with "path" and "content" string fields.');
      }
      return writeFile(path, content);
    },
  }),
  new DynamicTool({
    name: 'listDirectory',
    description:
      'Lists files and directories at a path. Input should be a directory path string. Returns newline-delimited entries.',
    func: async (path) => {
      const entries = await listDirectory(path || '.');
      return Array.isArray(entries) ? entries.join('\n') : entries;
    },
  }),
  new DynamicTool({
    name: 'runShellCommand',
    description:
      'Executes a shell command. Input should be the command string, e.g. "ls -la src". Returns stdout/stderr.',
    func: runShellCommand,
  }),
  new DynamicTool({
    name: 'searchFileContent',
    description:
      'Searches for a RegExp pattern inside project files. Input must be JSON: { "pattern": "<regex>", "path"?: "<root path>", "flags"?: "gim" }.',
    func: async (rawInput) => {
      const { pattern, path = './', flags = '' } = safeJsonParse(
        rawInput,
        'searchFileContent',
      );
      if (!pattern) {
        throw new Error('searchFileContent requires a "pattern" field.');
      }
      return searchFileContent(pattern, path, flags);
    },
  }),
  new DynamicTool({
    name: 'refactorCode',
    description:
      'Refactors code snippets. Input must be JSON: { "code": "<existing code>", "instructions": "<refactor goal>", "context": "<optional context>" }.',
    func: async (rawInput) => {
      const { code, instructions, context = '' } = safeJsonParse(rawInput, 'refactorCode');
      if (!code || !instructions) {
        throw new Error('refactorCode requires both "code" and "instructions" fields.');
      }
      const result = await refactorChain.invoke({ code, instructions, context });
      return result;
    },
  }),
];

const parseCliArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    mode: 'interactive',
    sessionId: process.env.AIRA_SESSION_ID || 'cli-session',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--session' && args[index + 1]) {
      options.sessionId = args[index + 1];
      index += 1;
    } else if (arg === '--ask' && args[index + 1]) {
      options.mode = 'single';
      options.initialInput = args[index + 1];
      index += 1;
    } else if (!arg.startsWith('--') && !options.initialInput) {
      options.mode = 'single';
      options.initialInput = arg;
    }
  }

  return options;
};

const main = async () => {
  const cliOptions = parseCliArgs();
  const refactorChain = createRefactorChain(ollama);
  const tools = buildTooling(refactorChain);
  logger.debug('Tooling initialized.', { toolCount: tools.length });
  const agent = await buildCodeAgent({
    llm: ollama,
    tools,
    sessionId: cliOptions.sessionId,
  });
  logger.info('AIra agent initialized.', { sessionId: cliOptions.sessionId });

  if (cliOptions.mode === 'single' && cliOptions.initialInput) {
    try {
      const response = await agent.invoke({
        input: cliOptions.initialInput,
        sessionId: cliOptions.sessionId,
      });
      const message = response.output || 'No response from AIra.';
      console.log(message);
    } catch (error) {
      logger.error('Single-shot execution failed.', { error: error.message });
      console.error(`AIra (error): ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const ask = async () => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim();
      if (EXIT_COMMANDS.has(trimmed.toLowerCase())) {
        console.log('AIra: Goodbye!');
        rl.close();
        return;
      }

      try {
        const response = await agent.invoke({
          input: trimmed,
          sessionId: cliOptions.sessionId,
        });
        console.log(response)
        const message = response.output || 'No response from AIra.';
        console.log(`AIra: ${message}`);
      } catch (error) {
        logger.error('Interactive invocation failed.', { error: error.message });
        console.error(`AIra (error): ${error.message}`);
      }

      ask();
    });
  };

  rl.on('SIGINT', () => {
    console.log('\nAIra: Session ended.');
    rl.close();
  });

  console.log('AIra is ready. Type your request, or "exit" to quit.');
  await ask();
};

main().catch((error) => {
  logger.error('Failed to start AIra.', { error: error.message });
  console.error(`Failed to start AIra: ${error.message}`);
  process.exitCode = 1;
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection.', { reason });
  console.error(`Unhandled rejection: ${reason}`);
});
