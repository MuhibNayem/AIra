import readline from 'readline';
import { promises as fs } from 'fs';
import 'dotenv/config';
import chalk from 'chalk';
import cliCursor from 'cli-cursor';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { ollama } from './llms/ollama.js';
import { readFile, writeFile, listDirectory, resolveFilePath } from './tools/file_system.js';
import { createShellTool } from './tools/shell_tool.js';
import { searchFileContent } from './tools/code_tools.js';
import { createRefactorChain } from './chains/refactor_chain.js';
import { buildCodeAgent } from './agents/code_agent.js';
import { logger } from './utils/logger.js';
import { detectSystemInfo, formatSystemPrompt } from './utils/system.js';
import { GEMINI_CLI_AGENT_PROMPT } from './prompts/agent_prompts.js';
import { resolveProjectPath } from './tools/path_tools.js';
import { extractUpdatedCode } from './utils/refactor.js';

const EXIT_COMMANDS = new Set(['exit', 'quit', 'q']);
const DEFAULT_THOUGHT_TEXT = 'Analyzing request...';
const TOOL_RESULT_PREVIEW_LIMIT = 280;
let cursorHookRegistered = false;

const registerCursorHook = () => {
  if (cursorHookRegistered) {
    return;
  }
  process.on('exit', () => {
    try {
      cliCursor.show();
    } catch (error) {
      logger.debug('Failed to show cursor on exit.', { error: error.message });
    }
  });
  cursorHookRegistered = true;
};

const truncate = (value, limit = TOOL_RESULT_PREVIEW_LIMIT) => {
  if (!value || value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit - 1)}…`;
};

const LINE_CONTEXT_RADIUS = 3;

export const buildLineStructure = (content) => {
  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
  const rawLines = content.split(/\r?\n/);
  const hasTrailingNewline =
    rawLines.length > 1 && rawLines[rawLines.length - 1] === '';
  let lines = hasTrailingNewline ? rawLines.slice(0, -1) : rawLines;
  if (lines.length === 1 && lines[0] === '') {
    lines = [];
  }

  return {
    lines,
    lineEnding,
    hasTrailingNewline,
  };
};

export const validateLineRange = (start, end, total) => {
  if (!Number.isInteger(start) || start < 1) {
    throw new Error('refactorFileSegment requires startLine to be a positive integer.');
  }
  if (!Number.isInteger(end) || end < start) {
    throw new Error('refactorFileSegment requires endLine to be >= startLine.');
  }
  if (start > total) {
    throw new Error(
      `refactorFileSegment received startLine ${start} but file only has ${total} lines.`,
    );
  }
};

export const sliceContext = (lines, startIndex, endIndex) => {
  const beforeStart = Math.max(0, startIndex - LINE_CONTEXT_RADIUS);
  const afterEnd = Math.min(lines.length, endIndex + LINE_CONTEXT_RADIUS);
  return {
    before: lines.slice(beforeStart, startIndex).join('\n'),
    after: lines.slice(endIndex, afterEnd).join('\n'),
  };
};

const messageTypeOf = (message) => {
  if (!message) {
    return 'unknown';
  }
  if (typeof message._getType === 'function') {
    return message._getType();
  }
  if (typeof message.getType === 'function') {
    return message.getType();
  }
  if (typeof message.type === 'string') {
    return message.type;
  }
  if (typeof message.role === 'string') {
    return message.role;
  }
  return 'unknown';
};

const contentToStrings = (content) => {
  if (!content) {
    return [];
  }

  if (typeof content === 'string') {
    return [content];
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (typeof part?.text === 'string') {
          return part.text;
        }
        return undefined;
      })
      .filter(Boolean);
  }

  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return [content.text];
  }

  return [];
};

const extractFinalResponseText = (messages) => {
  if (!Array.isArray(messages) || !messages.length) {
    return '';
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (messageTypeOf(message) !== 'ai') {
      continue;
    }
    const text = contentToStrings(message?.content)
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) {
      return text;
    }
  }

  return '';
};

const extractToolCalls = (message) => {
  const fromContent =
    Array.isArray(message?.content) && message.content.length
      ? message.content.filter((item) => item?.type === 'tool_call')
      : [];

  const explicit =
    message?.tool_calls ||
    message?.additional_kwargs?.tool_calls ||
    message?.kwargs?.tool_calls ||
    [];

  return [...explicit, ...fromContent];
};

const extractAgentEvents = (messages) => {
  const events = [];
  messages.forEach((message) => {
    const type = messageTypeOf(message);
    if (type === 'ai') {
      const thoughtSegments = contentToStrings(message?.content);
      thoughtSegments
        .map((segment) => segment.trim())
        .filter(Boolean)
        .forEach((segment) => {
          events.push({
            type: 'thought',
            text: segment,
          });
        });

      const toolCalls = extractToolCalls(message);
      toolCalls.forEach((call) => {
        const args = call?.args || call?.input || {};
        events.push({
          type: 'tool_call',
          id: call?.id || call?.tool_call_id || call?.name,
          toolName: call?.name || call?.tool,
          args,
        });
      });
    }

    if (type === 'tool') {
      const observation = contentToStrings(message?.content).join('\n').trim();
      events.push({
        type: 'tool_result',
        toolName: message?.name || message?.tool || message?.tool_call_id || 'unknown',
        output: truncate(observation || '[no output]'),
      });
    }
  });

  return events;
};

const createThoughtRenderer = () => {
  registerCursorHook();
  let active = false;
  let lastThought = '';

  const ensureCursorVisible = () => {
    try {
      cliCursor.show();
    } catch (error) {
      logger.debug('Failed to show cursor.', { error: error.message });
    }
  };

  return {
    start(label = DEFAULT_THOUGHT_TEXT) {
      cliCursor.hide();
      active = true;
      console.log(chalk.dim(`… ${label}`));
    },
    async flash(label) {
      if (!active) {
        return;
      }
      const normalized = label.trim();
      if (normalized && normalized !== lastThought) {
        lastThought = normalized;
        console.log(`${chalk.cyan('🧠')} ${normalized}`);
      }
    },
    persistStep(text, symbol = chalk.magenta('⚙')) {
      console.log(`${symbol} ${text}`);
    },
    succeed(message) {
      if (!active) {
        return;
      }
      console.log(`${chalk.green('✔')} ${chalk.green(message)}`);
      ensureCursorVisible();
      active = false;
      lastThought = '';
    },
    fail(message) {
      console.error(chalk.red(message));
      ensureCursorVisible();
      active = false;
      lastThought = '';
    },
  };
};

const playAgentTimeline = async (events, renderer) => {
  if (!events.length) {
    await renderer.flash('Formulating plan…');
    return;
  }

  let stepCount = 1;
  for (const event of events) {
    if (event.type === 'thought') {
      await renderer.flash(event.text);
    } else if (event.type === 'tool_call') {
      const argPreview = truncate(
        typeof event.args === 'string' ? event.args : JSON.stringify(event.args),
        TOOL_RESULT_PREVIEW_LIMIT,
      );
      renderer.persistStep(
        `${chalk.bold(`Step ${stepCount}`)} ${chalk.gray('→')} ${chalk.yellow(event.toolName || 'tool')} ${chalk.gray(argPreview)}`,
      );
      stepCount += 1;
    } else if (event.type === 'tool_result') {
      renderer.persistStep(
        `${chalk.gray('↳')} ${chalk.yellow(event.toolName)} ${chalk.gray('result:')} ${event.output}`,
        chalk.blue('⇢'),
      );
    }
  }
};

const runAgentTurn = async ({ agent, input, sessionId }) => {
  const renderer = createThoughtRenderer();
  renderer.start(DEFAULT_THOUGHT_TEXT);

  try {
    const response = await agent.invoke({
      input,
      sessionId,
    });
    const allMessages = Array.isArray(response?.messages) ? response.messages : [];
    const finalMessage = allMessages.at(-1);
    const eventMessages = Array.isArray(response?.eventMessages)
      ? response.eventMessages
      : allMessages.slice(0, -1);
    const events = extractAgentEvents(eventMessages);

    await playAgentTimeline(events, renderer);
    renderer.succeed('Thought process complete');

    const messageContent =
      typeof response?.output === 'string' && response.output.trim()
        ? response.output.trim()
        : extractFinalResponseText(allMessages) || 'No response from AIra.';

    console.log(`\n${chalk.bold.green('AIra')}: ${messageContent}`);
  } catch (error) {
    renderer.fail(`AIra error: ${error.message}`);
    throw error;
  } finally {
    // Ensure the cursor is visible if the renderer ended due to an early return.
    cliCursor.show();
  }
};

const buildTooling = (refactorChain, systemInfo) => {
  const catalog = [];
  const tools = [];

  const shellExecutor = createShellTool(systemInfo);

  const registerTool = (toolInstance, inputSchema) => {
    tools.push(toolInstance);
    catalog.push({
      name: toolInstance.name,
      description: toolInstance.description,
      input: inputSchema,
    });
  };

  registerTool(
    tool(
      async ({ path }) => readFile(path),
      {
        name: 'readFile',
        description: 'Reads the content of a UTF-8 text file. Input should be a filepath string.',
        schema: z.object({
          path: z.string().min(1, 'path is required'),
        }),
      },
    ),
    'path: string',
  );

  registerTool(
    tool(
      async ({ path, content }) => writeFile(path, content),
      {
        name: 'writeFile',
        description:
          'Writes UTF-8 content to a file. Input should be a JSON string: { "path": "<path>", "content": "<text>" }.',
        schema: z.object({
          path: z.string().min(1, 'path is required'),
          content: z.string(),
        }),
      },
    ),
    '{ path: string, content: string }',
  );

  registerTool(
    tool(
      async ({ path }) => {
        const entries = await listDirectory(path ?? '.');
        return Array.isArray(entries) ? entries.join('\n') : entries;
      },
      {
        name: 'listDirectory',
        description:
          'Lists files and directories at a path. Input should be a directory path string. Returns newline-delimited entries.',
        schema: z.object({
          path: z.string().optional(),
        }),
      },
    ),
    'path?: string',
  );

  registerTool(
    tool(
      async ({ query, cwd, limit }) => resolveProjectPath({ query, cwd, limit }),
      {
        name: 'resolvePath',
        description:
          'Finds absolute project paths matching a glob-style query. Useful before reading or modifying files.',
        schema: z.object({
          query: z.string().min(1, 'query is required'),
          cwd: z.string().optional(),
          limit: z.number().int().positive().optional(),
        }),
      },
    ),
    '{ query: string, cwd?: string, limit?: number }',
  );

  registerTool(
    tool(
      async () => JSON.stringify(detectSystemInfo(), null, 2),
      {
        name: 'getSystemInfo',
        description: 'Returns JSON describing the current operating system, architecture, and shell.',
        schema: z.object({}).optional(),
      },
    ),
    'null',
  );

  registerTool(
    tool(
      async ({ command }) => shellExecutor(command),
      {
        name: 'runShellCommand',
        description:
          'Executes a shell command. Input should be the command string, e.g. "ls -la src". Returns stdout/stderr.',
        schema: z.object({
          command: z.string().min(1, 'command is required'),
        }),
      },
    ),
    'command: string',
  );

  registerTool(
    tool(
      async ({ pattern, path = './', flags = '' }) =>
        searchFileContent(pattern, path, flags),
      {
        name: 'searchFileContent',
        description:
          'Searches for a RegExp pattern inside project files. Input must be JSON: { "pattern": "<regex>", "path"?: "<root path>", "flags"?: "gim" }.',
        schema: z.object({
          pattern: z.string().min(1, 'pattern is required'),
          path: z.string().optional(),
          flags: z.string().optional(),
        }),
      },
    ),
    '{ pattern: string, path?: string, flags?: string }',
  );

  registerTool(
    tool(
      async ({ code, instructions, context }) =>
        refactorChain.invoke({ code, instructions, context: context ?? '' }, {
          "recursionLimit": Number.isFinite(Number(process.env.AIRA_RECURSION_LIMIT))
            ? Number(process.env.AIRA_RECURSION_LIMIT)
            : 200
        }),
      {
        name: 'refactorCode',
        description:
          'Refactors code snippets. Input must be JSON: { "code": "<existing code>", "instructions": "<refactor goal>", "context": "<optional context>" }.',
        schema: z.object({
          code: z.string().min(1, 'code is required'),
          instructions: z.string().min(1, 'instructions are required'),
          context: z.string().optional(),
        }),
      },
    ),
    '{ code: string, instructions: string, context?: string }',
  );

  registerTool(
    tool(
      async ({ path, startLine, endLine, instructions }) => {
        const absolutePath = await resolveFilePath(path);
        let originalContent;
        try {
          originalContent = await fs.readFile(absolutePath, 'utf-8');
        } catch (error) {
          throw new Error(`Failed to read ${absolutePath}: ${error.message}`);
        }

        const { lines, lineEnding, hasTrailingNewline } = buildLineStructure(originalContent);
        if (lines.length === 0) {
          throw new Error('refactorFileSegment cannot operate on an empty file.');
        }
        validateLineRange(startLine, endLine, lines.length);

        const startIndex = Math.max(0, startLine - 1);
        const endIndex = Math.min(lines.length, endLine);
        const targetLines = lines.slice(startIndex, endIndex);
        const snippet = targetLines.join('\n');
        const context = sliceContext(lines, startIndex, endIndex);

        const refactorInput = {
          code: snippet,
          instructions,
          context: [
            `File: ${absolutePath}`,
            `Lines: ${startLine}-${endLine}`,
            context.before ? `Before:\n${context.before}` : '',
            context.after ? `After:\n${context.after}` : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        };

        const refactorResponse = await refactorChain.invoke(refactorInput);
        const { code: updatedCode } = extractUpdatedCode(refactorResponse);
        const normalizedSegment = updatedCode.replace(/\r\n/g, '\n').split('\n');

        const updatedLines = [
          ...lines.slice(0, startIndex),
          ...normalizedSegment,
          ...lines.slice(endIndex),
        ];

        let finalContent = updatedLines.join(lineEnding);
        if (hasTrailingNewline && !finalContent.endsWith(lineEnding)) {
          finalContent += lineEnding;
        }

        try {
          await fs.writeFile(absolutePath, finalContent, 'utf-8');
        } catch (error) {
          throw new Error(`Failed to write ${absolutePath}: ${error.message}`);
        }

        return JSON.stringify(
          {
            path: absolutePath,
            startLine,
            endLine,
            message: `Refactored lines ${startLine}-${endLine}`,
          },
          null,
          2,
        );
      },
      {
        name: 'refactorFileSegment',
        description:
          'Refactors a specific line range within a file. Input: { "path": string, "startLine": number, "endLine": number, "instructions": string }.',
        schema: z
          .object({
            path: z.string().min(1, 'path is required'),
            startLine: z.number().int().min(1),
            endLine: z.number().int().min(1),
            instructions: z.string().min(1, 'instructions are required'),
          })
          .refine((value) => value.endLine >= value.startLine, {
            message: 'endLine must be greater than or equal to startLine',
          }),
      },
    ),
    '{ path: string, startLine: number, endLine: number, instructions: string }',
  );

  registerTool(
    tool(
      async () => JSON.stringify(catalog, null, 2),
      {
        name: 'list_tools',
        description:
          'Lists all available tools alongside their descriptions and expected input structure as JSON.',
        schema: z.object({}).optional(),
      },
    ),
    'null',
  );

  return { tools, catalog };
};

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

// ...existing code...

const main = async () => {
  const cliOptions = parseCliArgs();
  const systemInfo = detectSystemInfo();
  const systemPrompt = `${GEMINI_CLI_AGENT_PROMPT.trim()}\n\nEnvironment Context:\n${formatSystemPrompt(
    systemInfo,
  )}`;
  const refactorChain = createRefactorChain(ollama);
  const { tools, catalog } = buildTooling(refactorChain, systemInfo);
  logger.debug('Tooling initialized.', { toolCount: tools.length });
  const recursionLimit = Number.isFinite(Number(process.env.AIRA_RECURSION_LIMIT))
    ? Number(process.env.AIRA_RECURSION_LIMIT)
    : 200;
  const llmWithTools = ollama.bindTools(tools);
  const agent = await buildCodeAgent({
    llm: llmWithTools,
    tools,
    sessionId: cliOptions.sessionId,
    systemPrompt,
    recursionLimit,
  });
  logger.info('AIra agent initialized.', {
    sessionId: cliOptions.sessionId,
    recursionLimit,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  rl.on('SIGINT', () => {
    console.log('\nAIra: Session ended.');
    rl.close();
    process.exit(0);
  });

  rl.on('close', () => {
    process.exit(0);
  });

  const ask = () => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim();
      if (EXIT_COMMANDS.has(trimmed.toLowerCase())) {
        console.log('AIra: Goodbye!');
        rl.close();
        return;
      }

      if (!trimmed) {
        ask();
        return;
      }

      try {
        await runAgentTurn({
          agent,
          input: trimmed,
          sessionId: cliOptions.sessionId,
        });
        // console.log(chalk.yellow('Note: Interactive mode is temporarily disabled.'));
      } catch (error) {
        logger.error('Interactive invocation failed.', { error: error.message });
      }

      ask();
    });
  };

  // Handle both single-shot and interactive modes using the same ask() function
  console.log('AIra is ready. Type your request, or "exit" to quit.');
  if (cliOptions.mode === 'single' && cliOptions.initialInput) {
    try {
      await runAgentTurn({
        agent,
        input: cliOptions.initialInput,
        sessionId: cliOptions.sessionId,
      });
      ask(); // Continue with interactive mode after handling initial input
    } catch (error) {
      logger.error('Single-shot execution failed.', { error: error.message });
      rl.close();
      process.exitCode = 1;
    }
  } else {
    ask(); // Start interactive mode directly
  }

  // Keep the process alive
  return new Promise(() => { });
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
