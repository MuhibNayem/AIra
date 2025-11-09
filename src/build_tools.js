import { z } from 'zod';
import fs from 'fs/promises';
import { tool } from '@langchain/core/tools';
import { resolveProjectPath } from './tools/path_tools.js';
import { extractUpdatedCode } from './utils/refactor.js';
import { createWebScraperTool } from './tools/web_scraper.js';
import { createWebSearchTool } from './tools/web_search.js';
import { createDirectoryTool, moveDirectoryTool, removeDirectoryTool } from './tools/directory_tools.js';
import { readFile, writeFile, listDirectory, resolveFilePath, readManyFiles, createManyFiles, listDirectoryStructure } from './tools/file_system.js';
import { createShellTool } from './tools/shell_tool.js';
import { searchFileContent } from './tools/code_tools.js';

/**
 * Wraps a tool function so its inputs/outputs are automatically stored in memory.
 */
const withMemory = (store, name, fn) => {
  return async (input, runtime) => {
    const result = await fn(input, runtime);

    try {
      const namespace = ['tool_memory', name];
      const key = `${Date.now()}_${name}`;
      await store.put(namespace, key, {
        tool: name,
        input,
        output: result,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(`[MemoryStore] Failed to save result for ${name}:`, err);
    }

    return result;
  };
};

/**
 * Builds the full LangGraph tool suite (ALL tools) with persistent memory integration.
 */
export const buildTooling = (refactorChain, systemInfo, store) => {
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

  // ------------------------------------------------------------------------------------
  // Core file tools
  // ------------------------------------------------------------------------------------

  registerTool(
    tool(
      withMemory(store, 'readFile', async ({ path }) => readFile(path)),
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
      withMemory(store, 'writeFile', async ({ path, content }) => writeFile(path, content)),
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
      withMemory(store, 'listDirectory', async ({ path }) => {
        const entries = await listDirectory(path ?? '.');
        return Array.isArray(entries) ? entries.join('\n') : entries;
      }),
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
      withMemory(store, 'resolvePath', async ({ query, cwd, limit }) =>
        resolveProjectPath({ query, cwd, limit })),
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
      withMemory(store, 'getSystemInfo', async () => JSON.stringify(detectSystemInfo(), null, 2)),
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
      withMemory(store, 'runShellCommand', async ({ command }) => shellExecutor(command)),
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
      withMemory(
        store,
        'searchFileContent',
        async ({ pattern, path = './', flags = '' }) => searchFileContent(pattern, path, flags),
      ),
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

  // ------------------------------------------------------------------------------------
  // Refactoring tools
  // ------------------------------------------------------------------------------------

  registerTool(
    tool(
      withMemory(
        store,
        'refactorCode',
        async ({ code, instructions, context }) =>
          refactorChain.invoke({ code, instructions, context: context ?? '' }, {
            recursionLimit: Number.isFinite(Number(process.env.AIRA_RECURSION_LIMIT))
              ? Number(process.env.AIRA_RECURSION_LIMIT)
              : 200,
          }),
      ),
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
      withMemory(
        store,
        'refactorFileSegment',
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
      ),
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

  // ------------------------------------------------------------------------------------
  // Multi-file + structure tools
  // ------------------------------------------------------------------------------------

  registerTool(
    tool(
      withMemory(store, 'readManyFiles', async ({ rootPath, extensions, maxFiles, maxDepth, includeContent }) => {
        const result = await readManyFiles(rootPath, {
          extensions: extensions || [],
          maxFiles: maxFiles || 100,
          maxDepth: maxDepth || 10,
          includeContent: includeContent !== false,
        });
        return JSON.stringify(result, null, 2);
      }),
      {
        name: 'readManyFiles',
        description: `Recursively reads multiple files from a directory tree. Useful for analyzing project structure, 
        reading multiple source files, or gathering codebase information. Automatically respects .gitignore and security policies.

        **Use this tool when you need to:**
        - Read all files in a directory and its subdirectories
        - Analyze multiple source files at once
        - Get an overview of project structure with file contents
        - Search for patterns across multiple files
        - Understand codebase organization

        **Examples:**
        - Read all JavaScript files: rootPath="./src", extensions=[".js", ".jsx"]
        - Read all config files: rootPath=".", extensions=[".json", ".yaml", ".yml"]
        - Get file list only: rootPath="./src", includeContent=false
        - Limit search depth: rootPath=".", maxDepth=2`,
        schema: z.object({
          rootPath: z.string().min(1, 'rootPath is required').describe('The root directory to start reading from (e.g., ".", "./src", "/absolute/path").'),
          extensions: z.array(z.string()).optional().describe('Optional: Array of file extensions to include (e.g., [".js", ".ts", ".json"]). If omitted, reads all files.'),
          maxFiles: z.number().int().positive().optional().default(150).describe('Optional: Maximum number of files to read. Defaults to 100 to prevent excessive memory usage.'),
          maxDepth: z.number().int().positive().optional().default(100).describe('Optional: Maximum directory depth to traverse. Defaults to 10 levels deep.'),
          includeContent: z.boolean().optional().default(true).describe('Optional: Whether to include file content (true) or just metadata like paths and sizes (false). Defaults to true.'),
        }),
      },
    ),
    '{ rootPath: string, extensions?: string[], maxFiles?: number, maxDepth?: number, includeContent?: boolean }',
  );

  registerTool(
    tool(
      withMemory(store, 'createManyFiles', async ({ rootPath, structure }) => createManyFiles(rootPath, structure)),
      {
        name: 'createManyFiles',
        description: `Creates multiple files and directories from a given structure. Automatically ensures directories exist and writes content to files. OS independent.

      **Use this tool when you need to:**
      - Quickly set up a file structure (e.g., for projects, environments, etc.)
      - Automate the creation of files in a given directory
      - Create an entire folder structure with content at once

      **Examples:**
      - Create a project structure with directories and files:
        rootPath: './project', structure: [{ path: 'src/index.js', content: 'console.log("Hello")' }, { path: 'README.md', content: '# Project' }]
      - Generate a directory structure without files:
        rootPath: './project', structure: [{ path: 'src', isDirectory: true }]
      `,
        schema: z.object({
          rootPath: z.string().min(1, 'rootPath is required').describe('The root directory where the files should be created.'),
          structure: z.array(
            z.object({
              path: z.string().min(1, 'path is required').describe('The file or directory path relative to the root directory.'),
              content: z.string().optional().describe('Content to be written to the file (if not a directory).'),
              isDirectory: z.boolean().optional().default(false).describe('Indicates whether the entry is a directory (defaults to false).'),
            }),
          ).min(1, 'structure is required').describe('An array of file and directory definitions to create in the given root path.'),
        }),
      },
    ),
    '{ rootPath: string, structure: { path: string, content?: string, isDirectory?: boolean }[] }',
  );

  registerTool(
    tool(
      withMemory(store, 'listDirectoryStructure', async ({ rootPath }) => listDirectoryStructure(rootPath)),
      {
        name: 'listDirectoryStructure',
        description: `Recursively lists the directory structure of a project. Useful for visualizing the folder hierarchy, checking directory contents, or documenting the project structure.

      **Use this tool when you need to:**
      - Display the folder structure of a project.
      - Inspect the organization of directories and files.
      - Export a project’s directory layout.

      **Examples:**
      - Get a full folder structure: rootPath="./project"
      - Get a folder structure of a specific directory: rootPath="./src"`,
        schema: z.object({
          rootPath: z.string().min(1, 'rootPath is required').describe('The root directory to start the listing from.'),
        }),
      },
    ),
    '{ rootPath: string }',
  );

  // ------------------------------------------------------------------------------------
  // Web & Directory tools (wrapped with memory)
  // ------------------------------------------------------------------------------------

  const webScraper = createWebScraperTool();
  webScraper.call = withMemory(store, 'web_scraper', webScraper.call.bind(webScraper));
  registerTool(webScraper, 'url: string');

  const webSearch = createWebSearchTool();
  webSearch.call = withMemory(store, 'web_search', webSearch.call.bind(webSearch));
  registerTool(webSearch, 'query: string');

  createDirectoryTool.call = withMemory(store, 'createDirectory', createDirectoryTool.call.bind(createDirectoryTool));
  moveDirectoryTool.call = withMemory(store, 'moveDirectory', moveDirectoryTool.call.bind(moveDirectoryTool));
  removeDirectoryTool.call = withMemory(store, 'removeDirectory', removeDirectoryTool.call.bind(removeDirectoryTool));

  registerTool(createDirectoryTool, '{ path: string, recursive?: boolean }');
  registerTool(moveDirectoryTool, '{ source: string, destination: string }');
  registerTool(removeDirectoryTool, '{ path: string, recursive?: boolean }');

  // ------------------------------------------------------------------------------------
  // Catalog listing tool
  // ------------------------------------------------------------------------------------

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
