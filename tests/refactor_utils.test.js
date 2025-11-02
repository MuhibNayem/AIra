import { describe, it, expect } from 'vitest';
import { extractUpdatedCode } from '../src/utils/refactor.js';

describe('extractUpdatedCode', () => {
  it('parses code block after Updated Code section', () => {
    const response = `---
Explanation:
- did something

Updated Code:
\`\`\`
console.log('hello');
\`\`\`
---`;

    const { code } = extractUpdatedCode(response);
    expect(code).toBe("console.log('hello');");
  });

  it('falls back to first generic code block when labeled section missing', () => {
    const response = `\`\`\`js
export const value = 1;
\`\`\``;

    const { code } = extractUpdatedCode(response);
    expect(code).toBe('export const value = 1;');
  });

  it('throws on responses without code blocks', () => {
    expect(() => extractUpdatedCode('no code here')).toThrow(
      /Failed to parse updated code block/,
    );
  });
});
