import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { extractSymbols, SUPPORTED_LANGUAGES, isLanguageSupported } from '../../../src/indexer/parsers/index.js';

const pythonSource = `
async def fetch(name: str) -> str:
    return name
`;

const goSource = `
package demo

type Person struct { Name string }

func (p *Person) Greet(times int) string { return "hi" }
`;

const javaSource = `
public class Person {
  public Person(String name) {}
  public String greet(int times) { return "hi"; }
}
`;

const jsSource = `
export const handler = () => null;
`;

describe('parser registry', () => {
  let tempDir;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'aira-parsers-'));
    await writeFile(path.join(tempDir, 'sample.py'), pythonSource, 'utf-8');
    await writeFile(path.join(tempDir, 'sample.go'), goSource, 'utf-8');
    await writeFile(path.join(tempDir, 'Person.java'), javaSource, 'utf-8');
    await writeFile(path.join(tempDir, 'handler.ts'), jsSource, 'utf-8');
  });

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('advertises supported languages', () => {
    expect(SUPPORTED_LANGUAGES.has('python')).toBe(true);
    expect(SUPPORTED_LANGUAGES.has('java')).toBe(true);
    expect(SUPPORTED_LANGUAGES.has('go')).toBe(true);
    expect(SUPPORTED_LANGUAGES.has('javascript')).toBe(true);
    expect(isLanguageSupported()).toBe(false);
  });

  it('routes extraction to specific language handlers', async () => {
    const pythonResult = await extractSymbols({
      filePath: path.join(tempDir, 'sample.py'),
      language: 'python',
    });
    expect(pythonResult.symbols.find((entry) => entry.name === 'fetch')).toBeDefined();

    const goResult = await extractSymbols({
      filePath: path.join(tempDir, 'sample.go'),
      language: 'go',
    });
    expect(goResult.symbols.find((entry) => entry.name === 'Person')).toBeDefined();

    const javaResult = await extractSymbols({
      filePath: path.join(tempDir, 'Person.java'),
      language: 'java',
    });
    expect(javaResult.symbols.find((entry) => entry.name === 'Person')).toBeDefined();

    const jsResult = await extractSymbols({
      filePath: path.join(tempDir, 'handler.ts'),
      language: 'typescript',
    });
    expect(jsResult.symbols.find((entry) => entry.name === 'handler')).toBeDefined();
  });

  it('returns diagnostic for unsupported languages', async () => {
    const result = await extractSymbols({
      filePath: path.join(tempDir, 'unknown.rb'),
      language: 'ruby',
    });
    expect(result.symbols).toHaveLength(0);
    expect(result.diagnostics[0]).toMatchObject({
      severity: 'warning',
    });
  });
});
