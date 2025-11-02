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
import { detectSystemInfo, formatSystemPrompt, getMemoryUsage } from './utils/system.js';
import { GEMINI_CLI_AGENT_PROMPT } from './prompts/agent_prompts.js';
import { resolveProjectPath } from './tools/path_tools.js';
import { extractUpdatedCode } from './utils/refactor.js';
import { createWebScraperTool } from './tools/web_scraper.js';
import { createWebSearchTool } from './tools/web_search.js'; 
import { runDiagnostics } from './diagnostics/onboarding.js';
import { runHealthCheck } from './diagnostics/health_check.js';
import { telemetry } from './utils/telemetry.js';

const EXIT_COMMANDS = new Set(['exit', 'quit', 'q']);
const DEFAULT_THOUGHT_TEXT = 'Analyzing request...';
const TOOL_RESULT_PREVIEW_LIMIT = 45;
const TOOL_ACTION_PREVIEW_LIMIT = 30;
let cursorHookRegistered = false;

const STRIP_ANSI_PATTERN = new RegExp(
  
  '[\\u001B\\u009B][[\\]()#;?]*(?:' +
    '(?:(?:[0-9]{1,4})(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]' +
    '|(?:[\\dA-PR-TZcf-nq-uy=><~]))',
  'g',
);

const stripAnsi = (value) => value.replace(STRIP_ANSI_PATTERN, '');

const renderFramedBlock = (lines, { borderColor = chalk.gray } = {}) => {
  if (!Array.isArray(lines) || !lines.length) {
    return;
  }

  const lineWidths = lines.map((line) => stripAnsi(line).length);
  const contentWidth = Math.max(2, ...lineWidths);
  const horizontal = '─'.repeat(contentWidth + 2);
  const border = borderColor;

  console.log(`\n${border(`╭${horizontal}╮`)}`);
  lines.forEach((line) => {
    const padding = contentWidth - stripAnsi(line).length;
    console.log(`${border('│')} ${line}${' '.repeat(padding)} ${border('│')}`);
  });
  console.log(border(`╰${horizontal}╯`));
};

const renderUserInput = (input) => {
  const rawLines = input.split(/\r?\n/);
  const decoratedLines = rawLines.map((line, index) =>
    index === 0
      ? `${chalk.bold.blue('You')} ${chalk.gray('→')} ${line}`
      : `  ${line}`,
  );
  renderFramedBlock(decoratedLines, { borderColor: chalk.blueBright });
};

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

const LINE_CONTEXT_RADIUS = 3;
const BYTES_IN_MB = 1024 * 1024;
const TOOL_OUTPUT_PREVIEW_LIMIT = 120;

const formatMegabytes = (bytes) => `${(bytes / BYTES_IN_MB).toFixed(1)} MB`;

const getMemoryStatusText = () => {
  const memory = getMemoryUsage();
  const usagePercent = memory.heapSizeLimit
    ? Math.min(100, (memory.heapUsed / memory.heapSizeLimit) * 100)
    : 0;

  return `Memory remaining: ${formatMegabytes(memory.remaining)} | used ${formatMegabytes(memory.heapUsed)} of ${formatMegabytes(memory.heapSizeLimit)} (${usagePercent.toFixed(1)}%)`;
};

const renderTokenUsage = ({ input = 0, output = 0, total = 0 } = {}) => {
  const lines = [
    chalk.bold.magenta('Session token usage'),
    `${chalk.gray('Input :')} ${chalk.white(input.toLocaleString())}`,
    `${chalk.gray('Output:')} ${chalk.white(output.toLocaleString())}`,
    `${chalk.gray('Total :')} ${chalk.white(total.toLocaleString())}`,
  ];
  renderFramedBlock(lines, { borderColor: chalk.magenta });
};

const getTerminalWidth = () => {
  const columns = process.stdout?.columns;
  return Number.isInteger(columns) ? Math.max(60, columns) : 120;
};

const toSingleLine = (value, limit = TOOL_RESULT_PREVIEW_LIMIT) => {
  if (value === null || value === undefined) {
    return '';
  }
  const raw =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value);
          } catch (_) {
            return String(value);
          }
        })();
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
};

const stringifyMessageContent = (content) => {
  if (!content) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('');
  }
  if (typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return '';
};

const renderToolOutput = (toolName, content) => {
  const name = toolName ? chalk.bold.yellow(toolName) : chalk.bold.yellow('tool');
  const columns = getTerminalWidth();
  const availableWidth = Math.max(30, columns - 4);

  const actionPrefix = `${name} ${chalk.gray('action:')} `;

  const resultPrefix = `${chalk.gray('result:')} `;
  const resultLimit = Math.max(10, availableWidth - stripAnsi(resultPrefix).length);
  const resultText = toSingleLine(content, resultLimit);
  const actionLine = `${actionPrefix}${chalk.gray(' → has Ran')}`;
  const resultLine = `${resultPrefix}${resultText ? chalk.white(resultText) : chalk.gray('[no output]')}`;

  const targetWidth = availableWidth;
  const padLine = (line) => {
    const plainLength = stripAnsi(line).length;
    const padding = Math.max(0, targetWidth - plainLength);
    return `${line}${' '.repeat(padding)}`;
  };

  renderFramedBlock([padLine(actionLine), padLine(resultLine)], { borderColor: chalk.yellowBright });
};

const summarizeActionArgs = (rawArgs, depth = 0) => {
  if (rawArgs === null || rawArgs === undefined) {
    return '';
  }

  const prioritizedKeys = [
    'query',
    'path',
    'pattern',
    'command',
    'content',
    'startLine',
    'endLine',
    'limit',
    'cwd',
  ];
  const ignoredKeys = new Set(['messages', 'config', 'context', 'metadata', 'callbacks']);
  const maxDepth = 2;
  const maxParts = 3;

  const normalizeInput = (value) => {
    if (typeof value !== 'string') {
      return value;
    }
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.parse(trimmed);
      } catch (_) {
        return value;
      }
    }
    return value;
  };

  const formatValue = (value) => {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      return JSON.stringify(value.slice(0, 3));
    }
    if (typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length === 1 && typeof value[keys[0]] === 'string') {
        return value[keys[0]];
      }
      return JSON.stringify(value);
    }
    return String(value);
  };

  const args = normalizeInput(rawArgs);

  if (depth > 3) {
    return '';
  }

  if (typeof args === 'string') {
    return toSingleLine(args, TOOL_ACTION_PREVIEW_LIMIT);
  }

  if (Array.isArray(args)) {
    return toSingleLine(JSON.stringify(args.slice(0, 3)), TOOL_ACTION_PREVIEW_LIMIT);
  }

  if (typeof args !== 'object') {
    return toSingleLine(String(args), TOOL_ACTION_PREVIEW_LIMIT);
  }

  if (args.tool_input !== undefined && args.tool_input !== args) {
    const nested = summarizeActionArgs(args.tool_input, depth + 1);
    if (nested) {
      return nested;
    }
  }

  if (args.kwargs !== undefined && args.kwargs !== args) {
    const nested = summarizeActionArgs(args.kwargs, depth + 1);
    if (nested) {
      return nested;
    }
  }

  const parts = [];
  const queue = [{ value: args, depth: 0 }];

  const enqueue = (value, depth) => {
    if (value === null || value === undefined) {
      return;
    }
    if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
      if (depth < maxDepth) {
        queue.push({ value, depth });
      }
    }
  };

  while (queue.length && parts.length < maxParts) {
    const { value, depth } = queue.shift();
    if (Array.isArray(value)) {
      if (!value.length) {
        continue;
      }
      enqueue(value[0], depth + 1);
      continue;
    }

    if (typeof value !== 'object' || value === null) {
      parts.push(toSingleLine(formatValue(value), TOOL_ACTION_PREVIEW_LIMIT));
      continue;
    }

    const entries = Object.entries(value);

    const candidates = entries.filter(([key]) => prioritizedKeys.includes(key));
    for (const [key, val] of candidates) {
      const formatted = formatValue(val);
      if (!formatted) {
        continue;
      }
      parts.push(toSingleLine(`${key}=${formatted}`, TOOL_ACTION_PREVIEW_LIMIT));
      if (parts.length >= maxParts) {
        break;
      }
    }
    if (parts.length >= maxParts) {
      break;
    }

    for (const [key, val] of entries) {
      if (ignoredKeys.has(key)) {
        enqueue(val, depth + 1);
        continue;
      }
      if (prioritizedKeys.includes(key)) {
        continue;
      }
      if (typeof val === 'object' && val !== null) {
        enqueue(val, depth + 1);
        continue;
      }
      const formatted = formatValue(val);
      if (formatted) {
        parts.push(toSingleLine(`${key}=${formatted}`, TOOL_ACTION_PREVIEW_LIMIT));
        if (parts.length >= maxParts) {
          break;
        }
      }
    }
  }

  if (!parts.length) {
    try {
      return toSingleLine(JSON.stringify(args), TOOL_ACTION_PREVIEW_LIMIT);
    } catch (_) {
      return toSingleLine(String(args), TOOL_ACTION_PREVIEW_LIMIT);
    }
  }

  return toSingleLine(parts.join(' · '), TOOL_ACTION_PREVIEW_LIMIT);
};

const messageTypeOfChunk = (message) => {
  if (!message) {
    return undefined;
  }
  if (typeof message._getType === 'function') {
    return message._getType();
  }
  if (typeof message.getType === 'function') {
    return message.getType();
  }
  return undefined;
};

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
        id: message?.tool_call_id || message?.tool || message?.name,
        output: toSingleLine(observation || '[no output]'),
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

const playAgentTimeline = async (events, renderer, { onToolCall, onToolResult } = {}) => {
  if (!events.length) {
    await renderer.flash('Formulating plan…');
    return;
  }

  const toolActions = new Map();
  let stepCount = 1;
  for (const event of events) {
    if (event.type === 'thought') {
      await renderer.flash(event.text);
    } else if (event.type === 'tool_call') {
      const toolName = event.toolName || (event.args && event.args.tool_name) || 'tool';
      const actionSummary = summarizeActionArgs(event.args?.tool_input ?? event.args);
      if (event.id) {
        toolActions.set(event.id, { summary: actionSummary, name: toolName });
      }
      if (event.toolName) {
        toolActions.set(event.toolName, { summary: actionSummary, name: toolName });
      }
      const stepSummary = actionSummary ? toSingleLine(actionSummary, TOOL_ACTION_PREVIEW_LIMIT) : '';
      const actionSegment = stepSummary ? ` ${chalk.gray(stepSummary)}` : '';
      renderer.persistStep(
        `${chalk.bold(`Step ${stepCount}`)} ${chalk.gray('→')} ${chalk.yellow(toolName)}${actionSegment}`,
      );
      if (typeof onToolCall === 'function') {
        onToolCall({
          id: event.id,
          toolName,
          args: event.args,
        });
      }
      stepCount += 1;
    } else if (event.type === 'tool_result') {
      const entry =
        (event.id && toolActions.get(event.id)) || (event.toolName && toolActions.get(event.toolName));
      const resolvedName = entry?.name || event.toolName || 'tool';

      renderToolOutput(resolvedName, event.output);
      if (event.id) {
        toolActions.delete(event.id);
      }
      if (event.toolName) {
        toolActions.delete(event.toolName);
      }
      if (typeof onToolResult === 'function') {
        onToolResult({
          id: event.id,
          toolName: resolvedName,
          output: event.output,
        });
      }
    }
  }
};

const runAgentTurn = async ({ agent, input, sessionId }) => {
  renderUserInput(input);
  const renderer = createThoughtRenderer();
  renderer.start(DEFAULT_THOUGHT_TEXT);
  const turnStart = process.hrtime.bigint();
  const initialUsage =
    typeof agent.getTokenUsage === 'function'
      ? { ...agent.getTokenUsage() }
      : null;
  const activeToolKeys = new Set();
  const toolKeyById = new Map();
  const toolQueueByName = new Map();
  const trackedToolCallIds = new Set();

  const registerToolStart = (identifier, toolName) => {
    if (identifier && trackedToolCallIds.has(identifier)) {
      return;
    }
    if (identifier) {
      trackedToolCallIds.add(identifier);
    }
    const key = telemetry.startToolInvocation({
      id: identifier,
      name: toolName,
      sessionId,
    });
    activeToolKeys.add(key);
    if (identifier) {
      toolKeyById.set(identifier, key);
    } else if (toolName) {
      const queue = toolQueueByName.get(toolName) ?? [];
      queue.push(key);
      toolQueueByName.set(toolName, queue);
    }
  };

  const resolveToolKey = (identifier, toolName) => {
    if (identifier && toolKeyById.has(identifier)) {
      const key = toolKeyById.get(identifier);
      toolKeyById.delete(identifier);
      return key;
    }
    if (toolName && toolQueueByName.has(toolName)) {
      const queue = toolQueueByName.get(toolName);
      if (queue && queue.length) {
        const key = queue.shift();
        if (!queue.length) {
          toolQueueByName.delete(toolName);
        } else {
          toolQueueByName.set(toolName, queue);
        }
        return key;
      }
    }
    return null;
  };

  const finalizeTool = (identifier, toolName, { success = true, error } = {}) => {
    const key = resolveToolKey(identifier, toolName);
    if (!key) {
      return;
    }
    if (activeToolKeys.has(key)) {
      activeToolKeys.delete(key);
    }
    if (identifier) {
      trackedToolCallIds.delete(identifier);
    }
    telemetry.finishToolInvocation(key, { success, error });
  };

  const supportsStreaming = typeof agent.streamInvoke === 'function';
  let streamedHeaderShown = false;
  let needsNewline = false;
  let printedChunks = false;
  const streamToolActions = new Map();
  const pendingStreamToolIds = new Set();
  let turnCompleted = false;
  let turnErrorMessage;
  const mergeArgumentText = (existing = '', addition = '') => {
    if (!addition) {
      return existing || '';
    }
    if (!existing) {
      return addition;
    }
    if (addition.startsWith(existing)) {
      return addition;
    }
    if (existing.endsWith(addition)) {
      return existing;
    }
    return `${existing}${addition}`;
  };
  const computeEntrySummary = (entry) => {
    const source =
      entry.args !== undefined && entry.args !== null && entry.args !== ''
        ? entry.args
        : entry.argText;
    if (source === undefined || source === null) {
      return entry.summary || '';
    }
    if (typeof source === 'string' && !source.trim()) {
      return entry.summary || '';
    }
    try {
      return summarizeActionArgs(source);
    } catch (_) {
      return entry.summary || '';
    }
  };
  const upsertStreamAction = ({ keys, name, summary, args, argText }) => {
    const normalizedKeys = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
    if (!normalizedKeys.length) {
      return;
    }
    let entry =
      normalizedKeys.reduce((found, key) => found || streamToolActions.get(key), null) || {
        name: undefined,
        args: undefined,
        argText: '',
        summary: '',
        keys: new Set(),
      };
    if (name && name !== entry.name) {
      entry.name = name;
    }
    if (typeof args !== 'undefined') {
      entry.args = args;
    }
    if (typeof argText === 'string' && argText) {
      entry.argText = mergeArgumentText(entry.argText, argText);
      if (!entry.args) {
        try {
          entry.args = JSON.parse(entry.argText);
        } catch (_) {
          
        }
      }
    }
    if (typeof summary === 'string' && summary.trim()) {
      entry.summary = summary.trim();
    }
    entry.summary = computeEntrySummary(entry);
    normalizedKeys.forEach((key) => {
      entry.keys.add(key);
      streamToolActions.set(key, entry);
    });
  };
  const getStreamAction = (...keys) => {
    for (const key of keys) {
      if (!key) {
        continue;
      }
      const entry = streamToolActions.get(key);
      if (entry) {
        return { name: entry.name, summary: entry.summary };
      }
    }
    return null;
  };
  const deleteStreamAction = (...keys) => {
    const processed = new Set();
    keys.filter(Boolean).forEach((key) => {
      const entry = streamToolActions.get(key);
      if (entry && !processed.has(entry)) {
        entry.keys?.forEach((linkedKey) => streamToolActions.delete(linkedKey));
        processed.add(entry);
      } else {
        streamToolActions.delete(key);
      }
    });
  };
  let response;

  const flushStreamLine = () => {
    if (needsNewline) {
      process.stdout.write('\n');
      needsNewline = false;
    }
  };

  const handleStreamEvent = async ({ mode, payload }) => {
    const registerStreamToolCalls = (...sources) => {
      sources
        .filter(Boolean)
        .forEach((source) => {
          const explicitCalls = extractToolCalls(source) ?? [];
          const directCalls = Array.isArray(source?.tool_calls) ? source.tool_calls : [];
          const deltaCalls = Array.isArray(source?.delta?.tool_calls) ? source.delta.tool_calls : [];
          const toolCalls = [...explicitCalls, ...directCalls, ...deltaCalls];
          if (!toolCalls?.length) {
            return;
          }
          toolCalls.forEach((call) => {
            const deltaPayload = call?.delta || {};
            const functionPayload = call?.function || deltaPayload?.function || {};
            const toolCallId =
              call?.id ||
              call?.tool_call_id ||
              deltaPayload?.id ||
              call?.name ||
              call?.tool;
            const toolName = call?.name || call?.tool || functionPayload?.name;
            const argsCandidate =
              call?.args ??
              call?.input ??
              call?.tool_input ??
              call?.kwargs ??
              call?.function?.input ??
              functionPayload?.input ??
              call?.arguments ??
              deltaPayload?.arguments;
            const argumentText =
              typeof argsCandidate === 'string'
                ? argsCandidate
                : typeof call?.function?.arguments === 'string'
                  ? call.function.arguments
                  : typeof functionPayload?.arguments === 'string'
                    ? functionPayload.arguments
                    : typeof call?.arguments === 'string'
                      ? call.arguments
                      : typeof deltaPayload?.function?.arguments === 'string'
                        ? deltaPayload.function.arguments
                        : typeof deltaPayload?.arguments === 'string'
                          ? deltaPayload.arguments
                          : undefined;
            const normalizedArgs =
              typeof argsCandidate === 'string'
                ? undefined
                : argsCandidate !== undefined
                  ? argsCandidate
                  : typeof call?.arguments === 'object'
                    ? call.arguments
                    : typeof deltaPayload?.arguments === 'object'
                      ? deltaPayload.arguments
                      : undefined;
            const keys = [toolCallId, toolName].filter(Boolean);
            if (!keys.length) {
              return;
            }
            const pendingKey = toolCallId || toolName;
            if (pendingKey && !pendingStreamToolIds.has(pendingKey)) {
              registerToolStart(toolCallId, toolName);
              pendingStreamToolIds.add(pendingKey);
            }
            upsertStreamAction({
              keys,
              name: toolName,
              args: normalizedArgs,
              argText: argumentText,
            });
          });
        });
    };

    if (mode === 'messages') {
      const [message, metadata] = payload || [];
      if (!message) {
        return;
      }
      const messageType = messageTypeOfChunk(message);
      registerStreamToolCalls(
        message,
        metadata,
        metadata?.delta,
        metadata?.tool_call_delta,
        metadata?.tool_call,
      );
      const text = stringifyMessageContent(message.content);
      if (!text) {
        return;
      }

      if (messageType === 'ai_chunk' || messageType === 'ai') {
        if (!streamedHeaderShown) {
          console.log(`\n${chalk.bold.green('AIra')}:`);
          streamedHeaderShown = true;
        }
        if (messageType === 'ai_chunk') {
          process.stdout.write(text);
          needsNewline = !text.endsWith('\n');
          printedChunks = true;
        } else if (!printedChunks) {
          process.stdout.write(text);
          needsNewline = !text.endsWith('\n');
        }
      } else if (messageType === 'tool') {
        flushStreamLine();
        const toolCallId = metadata?.tool_call_id || metadata?.task_id || message?.tool_call_id;
        const toolName = message?.name || metadata?.tool || metadata?.name || 'tool';
        const metadataArgs =
          metadata?.tool_input ??
          metadata?.input ??
          metadata?.result ??
          metadata?.args;
        const metadataArgText =
          typeof metadataArgs === 'string'
            ? metadataArgs
            : typeof metadata?.arguments === 'string'
              ? metadata?.arguments
              : undefined;
        upsertStreamAction({
          keys: [toolCallId, toolName],
          name: toolName,
          args: typeof metadataArgs === 'string' ? undefined : metadataArgs,
          argText: metadataArgText,
        });
        const entry = getStreamAction(toolCallId, toolName);
        const resolvedName = entry?.name || toolName;
        renderToolOutput(resolvedName, text);
        finalizeTool(toolCallId, resolvedName, { success: true });
        deleteStreamAction(toolCallId, toolName, entry?.name);
        pendingStreamToolIds.delete(toolCallId || resolvedName || toolName);
      }
    }

    if (mode === 'tasks') {
      const task = payload;
      if (task && typeof task === 'object') {
        flushStreamLine();
        if (Object.prototype.hasOwnProperty.call(task, 'input')) {
          const toolNameHint =
            typeof task.input?.tool_name === 'string' ? task.input.tool_name : task.name || 'tool';
          const toolInput = task.input?.tool_input ?? task.input;
          const actionSummary = summarizeActionArgs(toolInput);
          const toolCallId = task.tool_call_id || task.id;
          registerToolStart(toolCallId, toolNameHint);
          upsertStreamAction({
            keys: [toolCallId, toolNameHint, task.name],
            name: toolNameHint,
            args: toolInput,
            summary: actionSummary,
          });
          renderer.persistStep(
            `${chalk.bold(toolNameHint || task.name || 'Task')} ${chalk.gray('started')}`,
          );
        } else if (Object.prototype.hasOwnProperty.call(task, 'result')) {
          renderer.persistStep(
            `${chalk.gray('↳')} ${task.name || 'Task'} ${chalk.gray('completed')}`,
          );
          const toolCallId = task.tool_call_id || task.id;
          const toolNameHint =
            typeof task.result?.tool_name === 'string' ? task.result.tool_name : task.name || 'tool';
          finalizeTool(toolCallId, toolNameHint, { success: true });
          pendingStreamToolIds.delete(toolCallId || toolNameHint || task.name);
          deleteStreamAction(toolCallId, toolNameHint, task.name);
        }
      }
    }
  };

  try {
    if (supportsStreaming) {
      response = await agent.streamInvoke(
        {
          input,
          sessionId,
        },
        {
          onEvent: handleStreamEvent,
        },
      );
    } else {
      response = await agent.invoke({
        input,
        sessionId,
      });
      const allMessages = Array.isArray(response?.messages) ? response.messages : [];
      const eventMessages = Array.isArray(response?.eventMessages)
        ? response.eventMessages
        : allMessages.slice(0, -1);
      const events = extractAgentEvents(eventMessages);
      await playAgentTimeline(events, renderer, {
        onToolCall: ({ id, toolName }) => registerToolStart(id, toolName),
        onToolResult: ({ id, toolName }) => finalizeTool(id, toolName, { success: true }),
      });
    }

    const allMessages = Array.isArray(response?.messages) ? response.messages : [];
    const messageContent =
      typeof response?.output === 'string' && response.output.trim()
        ? response.output.trim()
        : extractFinalResponseText(allMessages) || 'No response from AIra.';

    if (supportsStreaming) {
      if (!streamedHeaderShown) {
        console.log(`\n${chalk.bold.green('AIra')}: ${messageContent}`);
      } else {
        flushStreamLine();
      }
    } else {
      console.log(`\n${chalk.bold.green('AIra')}: ${messageContent}`);
    }

    renderer.succeed('Thought process complete');
    turnCompleted = true;
  } catch (error) {
    renderer.fail(`AIra error: ${error.message}`);
    turnErrorMessage = error.message;
    activeToolKeys.forEach((key) => {
      telemetry.finishToolInvocation(key, { success: false, error: error.message });
    });
    activeToolKeys.clear();
    toolKeyById.clear();
    toolQueueByName.clear();
    pendingStreamToolIds.clear();
    throw error;
  } finally {
    cliCursor.show();
    const finalUsage =
      typeof agent.getTokenUsage === 'function'
        ? { ...agent.getTokenUsage() }
        : null;
    const inputDelta =
      initialUsage && finalUsage
        ? Math.max(0, (finalUsage.input ?? 0) - (initialUsage.input ?? 0))
        : finalUsage?.input ?? 0;
    const outputDelta =
      initialUsage && finalUsage
        ? Math.max(0, (finalUsage.output ?? 0) - (initialUsage.output ?? 0))
        : finalUsage?.output ?? 0;
    const durationMs = Number((process.hrtime.bigint() - turnStart) / 1_000_000n);
    if (activeToolKeys.size) {
      activeToolKeys.forEach((key) => {
        telemetry.finishToolInvocation(key, {
          success: false,
          error: turnErrorMessage || 'Tool invocation did not complete before turn end.',
        });
      });
      activeToolKeys.clear();
    }
    toolKeyById.clear();
    toolQueueByName.clear();
    pendingStreamToolIds.clear();
    const turnSuccess = Boolean(turnCompleted);
    telemetry.recordTurn({
      sessionId,
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      success: turnSuccess,
      inputTokens: inputDelta,
      outputTokens: outputDelta,
      error: turnSuccess ? undefined : turnErrorMessage || 'Turn ended with errors.',
    });
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
  registerTool(createWebScraperTool(), 'url: string');
  registerTool(createWebSearchTool(), 'query: string');

  return { tools, catalog };
};

const parseCliArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    mode: 'interactive',
    sessionId: process.env.AIRA_SESSION_ID || 'cli-session',
    skipStartupCheck: false,
    diagnostics: {
      enabled: false,
      autoFix: false,
      skipPull: false,
      skipSelfCheck: false,
      reportPath: undefined,
    },
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--check' || arg === '--doctor') {
      options.mode = 'diagnostics';
      options.diagnostics.enabled = true;
      continue;
    }
    if (arg === '--health') {
      options.mode = 'health';
      continue;
    }
    if (arg === '--fix') {
      options.diagnostics.autoFix = true;
      continue;
    }
    if (arg === '--skip-check' || arg === '--no-check' || arg === '--skip-startup-check') {
      options.skipStartupCheck = true;
      continue;
    }
    if (arg === '--skip-pull') {
      options.diagnostics.skipPull = true;
      continue;
    }
    if (arg === '--skip-self-check') {
      options.diagnostics.skipSelfCheck = true;
      continue;
    }
    if ((arg === '--report' || arg === '--report-path') && args[index + 1]) {
      options.diagnostics.reportPath = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--no-report') {
      options.diagnostics.reportPath = null;
      continue;
    }
    if (arg === '--session' && args[index + 1]) {
      options.sessionId = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--ask' && args[index + 1]) {
      options.mode = 'single';
      options.initialInput = args[index + 1];
      index += 1;
      continue;
    }
    if (!arg.startsWith('--') && !options.initialInput) {
      options.mode = 'single';
      options.initialInput = arg;
    }
  }

  if (options.diagnostics.enabled) {
    options.mode = 'diagnostics';
  }

  if (
    process.env.AIRA_NO_STARTUP_CHECK === '1' ||
    process.env.AIRA_SKIP_STARTUP_CHECK === '1'
  ) {
    options.skipStartupCheck = true;
  }

  return options;
};

const main = async () => {
  const cliOptions = parseCliArgs();

  if (cliOptions.mode === 'health') {
    const report = await runHealthCheck();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'ok' ? 0 : 1;
    return;
  }

  if (cliOptions.mode === 'diagnostics') {
    const { diagnostics } = cliOptions;
    const result = await runDiagnostics({
      autoFix: diagnostics.autoFix,
      skipPull: diagnostics.skipPull,
      skipSelfCheck: diagnostics.skipSelfCheck,
      reportPath: diagnostics.reportPath,
    });
    if (!result.success) {
      process.exitCode = 1;
    }
    return;
  }

  if (!cliOptions.skipStartupCheck) {
    const prerequisites = await runDiagnostics({
      autoFix: false,
      skipSelfCheck: true,
      reportPath: null,
      silent: true,
    });
    if (!prerequisites.success) {
      console.log(chalk.red('AIra prerequisites are missing or incomplete:'));
      prerequisites.friction.forEach(({ message }, index) => {
        console.log(chalk.yellow(`  ${index + 1}. ${message}`));
      });
      console.log(
        chalk.gray(
          '\nRun "aira --check" to review details or "aira --check --fix" to attempt automatic remediation.',
        ),
      );
      process.exitCode = 1;
      return;
    }
  }

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
    recursionLimit: recursionLimit,
    toolCatalog: catalog,
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
    console.log(chalk.dim(getMemoryStatusText()));
    rl.question(chalk.bold.yellowBright('› '), async (input) => {
      const trimmed = input.trim();
      if (EXIT_COMMANDS.has(trimmed.toLowerCase())) {
        console.log('AIra: Goodbye!');
        rl.close();
        return;
      }

      if (trimmed.toLowerCase() === '/token') {
        const usage =
          typeof agent.getTokenUsage === 'function'
            ? agent.getTokenUsage()
            : { input: 0, output: 0, total: 0 };
        renderTokenUsage(usage);
        ask();
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
      } catch (error) {
        logger.error("Interactive invocation failed.", {
          error: error.message,
        });
      }

      ask();
    });
  };

  
  console.log('AIra is ready. Type your request, or "exit" to quit.');
  if (cliOptions.mode === 'single' && cliOptions.initialInput) {
    try {
      await runAgentTurn({
        agent,
        input: cliOptions.initialInput,
        sessionId: cliOptions.sessionId,
      });
      ask(); 
    } catch (error) {
      logger.error('Single-shot execution failed.', { error: error.message });
      rl.close();
      process.exitCode = 1;
    }
  } else {
    ask(); 
  }

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
