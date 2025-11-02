import { describe, it, expect } from 'vitest';
import { extractSymbolsFromSource } from '../../../src/indexer/parsers/python.js';

const extract = (source, filePath = '/repo/app.py') =>
  extractSymbolsFromSource({
    source,
    filePath,
    language: 'python',
  });

describe('python parser (tree-sitter)', () => {
  it('extracts modules, classes, and methods with relations', () => {
    const source = `
@cache
async def fetch(name: str) -> str:
    return name

class Person(Base, Identified):
    def __init__(self, name):
        self.name = name

    def greet(self) -> str:
        return f"hi {self.name}"
`;
    const result = extract(source);
    const names = result.symbols.map((symbol) => symbol.name);
    expect(names).toEqual(['fetch', 'Person', '__init__', 'greet']);

    const fetch = result.symbols.find((entry) => entry.name === 'fetch');
    expect(fetch.kind).toBe('function');
    expect(fetch.properties.async).toBe(true);
    expect(fetch.properties.decorators).toEqual(['cache']);
    expect(fetch.detail.parameters).toEqual(['name: str']);
    expect(fetch.detail.returnType).toBe('str');

    const person = result.symbols.find((entry) => entry.name === 'Person');
    expect(person.kind).toBe('class');
    expect(person.detail.bases).toEqual(['Base', 'Identified']);

    const greet = result.symbols.find((entry) => entry.name === 'greet');
    expect(greet.kind).toBe('method');
    expect(greet.properties.parent).toBe('Person');
    expect(greet.detail.parameters).toEqual(['self']);
    expect(greet.detail.returnType).toBe('str');

    const relation = result.relations.find(
      (entry) => entry.sourceId === greet.id && entry.type === 'belongs_to',
    );
    expect(relation).toBeDefined();
    expect(relation.targetId).toBe(person.id);
  });

  it('records diagnostics when syntax errors exist', () => {
    const source = `
def broken(
    return 1
`;
    const result = extract(source, '/repo/broken.py');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0].severity).toBe('error');
    expect(result.diagnostics[0].message).toContain('Tree-sitter detected syntax errors');
  });
});
