
import { promises as fs } from 'fs';
import path from 'path';
import { tool }from '@langchain/core/tools';
import { z } from 'zod';
import { ensureWriteAllowed, ensureReadAllowed } from '../utils/security.js';

export const createDirectoryTool = tool(
  async ({ path: dirPath, recursive = true }) => {
    const absolutePath = path.resolve(dirPath);
    ensureWriteAllowed(absolutePath);
    try {
      await fs.mkdir(absolutePath, { recursive });
      return `Successfully created directory: ${absolutePath}`;
    } catch (error) {
      throw new Error(`Failed to create directory ${absolutePath}: ${error.message}`);
    }
  },
  {
    name: 'createDirectory',
    description: 'Creates a new directory. Input should be a JSON string: { "path": "<path>", "recursive"?: boolean }.',
    schema: z.object({
      path: z.string().min(1, 'path is required'),
      recursive: z.boolean().optional().default(true),
    }),
  },
);

export const removeDirectoryTool = tool(
  async ({ path: dirPath, recursive = false }) => {
    const absolutePath = path.resolve(dirPath);
    ensureWriteAllowed(absolutePath);

    if (recursive) {
      await fs.rm(absolutePath, { recursive: true, force: true });
      return `Successfully removed directory recursively: ${absolutePath}`;
    }

    try {
      await fs.rmdir(absolutePath);
      return `Successfully removed directory: ${absolutePath}`;
    } catch (error) {
      if (error.code === 'ENOTEMPTY') {
        throw new Error(`Failed to remove directory ${absolutePath}: It is not empty. Use the 'recursive' option to delete it and its contents.`);
      }
      throw new Error(`Failed to remove directory ${absolutePath}: ${error.message}`);
    }
  },
  {
    name: 'removeDirectory',
    description: 'Removes a directory. Fails if the directory is not empty, unless recursive is true. Input: { "path": string, "recursive"?: boolean }',
    schema: z.object({
      path: z.string().min(1, 'path is required'),
      recursive: z.boolean().optional().default(false),
    }),
  },
);

export const moveDirectoryTool = tool(
  async ({ source, destination }) => {
    const absoluteSource = path.resolve(source);
    const absoluteDestination = path.resolve(destination);
    ensureReadAllowed(absoluteSource);
    ensureWriteAllowed(absoluteSource); 
    ensureWriteAllowed(absoluteDestination);

    try {
      await fs.rename(absoluteSource, absoluteDestination);
      return `Successfully moved directory from ${absoluteSource} to ${absoluteDestination}`;
    } catch (error) {
      throw new Error(`Failed to move directory: ${error.message}`);
    }
  },
  {
    name: 'moveDirectory',
    description: 'Moves or renames a directory. Input: { "source": string, "destination": string }',
    schema: z.object({
      source: z.string().min(1, 'source path is required'),
      destination: z.string().min(1, 'destination path is required'),
    }),
  },
);

