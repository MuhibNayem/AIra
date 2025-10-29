import { promises as fs } from 'fs';

/**
 * Reads the content of a file.
 * @param {string} path The path to the file.
 * @returns {Promise<string>} The content of the file.
 */
export const readFile = async (path) => {
  try {
    return await fs.readFile(path, 'utf-8');
  } catch (error) {
    return `Error reading file: ${error.message}`;
  }
};

/**
 * Writes content to a file.
 * @param {string} path The path to the file.
 * @param {string} content The content to write.
 * @returns {Promise<string>} A confirmation message.
 */
export const writeFile = async (path, content) => {
  try {
    await fs.writeFile(path, content, 'utf-8');
    return `Successfully wrote to ${path}`;
  } catch (error) {
    return `Error writing to file: ${error.message}`;
  }
};

/**
 * Lists the files and directories in a given path.
 * @param {string} path The path to the directory.
 * @returns {Promise<string[]>} A list of files and directories.
 */
export const listDirectory = async (path) => {
  try {
    const files = await fs.readdir(path);
    return files;
  } catch (error) {
    return `Error listing directory: ${error.message}`;
  }
};