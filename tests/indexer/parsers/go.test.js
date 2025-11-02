import { describe, it, expect } from 'vitest';
import { extractSymbolsFromSource } from '../../../src/indexer/parsers/go.js';

const extract = (source, filePath = '/repo/main.go') =>
  extractSymbolsFromSource({
    source,
    filePath,
    language: 'go',
  });

describe('go parser (tree-sitter)', () => {
  it('extracts structs, methods, and free functions', () => {
const source = `
package demo

type Person struct {
  Name string
}

type Greeter interface {
  Greet(times int) string
}

func (p *Person) Greet(times int) string {
  return "hi"
}

func Say(name string) string {
  return name
}
`;
    const result = extract(source);
    const names = result.symbols.map((symbol) => symbol.name);
    expect(names).toEqual(['Person', 'Greeter', 'Greet', 'Say']);

    const person = result.symbols.find((entry) => entry.name === 'Person');
    expect(person.kind).toBe('struct');
    expect(person.properties.source).toBe('type_declaration');

    const greeter = result.symbols.find((entry) => entry.name === 'Greeter');
    expect(greeter.kind).toBe('interface');
    expect(greeter.properties.rawType).toContain('interface');

    const greet = result.symbols.find((entry) => entry.name === 'Greet');
    expect(greet.kind).toBe('method');
    expect(greet.properties.receiver).toBe('(p *Person)');
    expect(greet.detail.parameters).toEqual(['times int']);
    expect(greet.detail.returnType).toBe('string');

    const say = result.symbols.find((entry) => entry.name === 'Say');
    expect(say.kind).toBe('function');
    expect(say.properties.exported).toBe(true);

    const relation = result.relations.find(
      (entry) => entry.sourceId === greet.id && entry.type === 'belongs_to',
    );
    expect(relation).toBeDefined();
    expect(relation.properties.receiver).toBe('(p *Person)');
    expect(relation.targetId).toBe(person.id);
  });

  it('captures syntax diagnostics', () => {
    const source = `
package demo
func broken( {
`;
    const result = extract(source, '/repo/broken.go');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0].severity).toBe('error');
  });
});
