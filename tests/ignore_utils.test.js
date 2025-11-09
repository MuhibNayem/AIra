import { describe, it, expect } from 'vitest';
import path from 'path';
import { isPathIgnored, filterIgnoredEntries } from '../src/utils/ignore.js';

describe('ignore utilities', () => {
  it('identifies ignored directories inside paths', () => {
    const ignored = isPathIgnored(path.join('/tmp', 'node_modules', 'pkg', 'index.js'));
    expect(ignored).toBe(true);
  });

  it('returns false for safe or falsy paths', () => {
    expect(isPathIgnored('')).toBe(false);
    expect(isPathIgnored(null)).toBe(false);
    expect(isPathIgnored(path.join('src', 'app.js'))).toBe(false);
  });

  it('filters ignored entries from directory listings', () => {
    const entries = ['src', 'node_modules', '.git', 'docs'];
    const filtered = filterIgnoredEntries(entries);
    expect(filtered).toEqual(['src', 'docs']);
  });
});
