import { promises as fs } from 'fs';
import { glob } from 'glob';
import { join, resolve } from 'path';
import { IGNORED_GLOB_PATTERNS, isPathIgnored } from '../utils/ignore.js';

/**
 * Searches for a pattern in the content of files.
 * @param {string} pattern The pattern to search for.
 * @param {string} path The path to search in.
 * @returns {Promise<string>} A list of files and lines containing the pattern.
 */
export const searchFileContent = async (pattern, path = './', flags = '') => {
  try {
    const searchRoot = resolve(path);
    const files = await glob('**/*', {
      cwd: searchRoot,
      nodir: true,
      ignore: IGNORED_GLOB_PATTERNS,
    });
    const results = [];
    let regex;

    try {
      regex = new RegExp(pattern, flags);
    } catch (regexError) {
      return `Invalid regular expression: ${regexError.message}`;
    }

    for (const file of files) {
      const filePath = join(searchRoot, file);
      if (isPathIgnored(filePath)) {
        continue;
      }
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push(`${filePath}:${i + 1}: ${lines[i]}`);
          }
        }
      } catch (readError) {
        
      }
    }
    return results.length ? results.join('\n') : 'No matches found.';
  } catch (error) {
    return `Error searching files: ${error.message}`;
  }
};
