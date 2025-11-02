import { describe, it, expect } from 'vitest';
import { extractSymbolsFromSource } from '../../../src/indexer/parsers/javascript.js';

const extract = (source, language = 'javascript', filePath = '/tmp/sample.ts') =>
  extractSymbolsFromSource({ source, language, filePath });

describe('tree-sitter javascript/TypeScript parser', () => {
  it('captures function, class, and variable function declarations', () => {
    const source = `
      export async function greet(name: string): string {
        return 'hi';
      }

      export class Person {
        constructor(private readonly name: string) {}
        sayHi(): string {
          return \`Hello \${this.name}\`;
        }
      }

      const handler = (event) => {
        return event;
      };
    `;

    const result = extract(source, 'typescript', '/repo/src/person.ts');
    const names = result.symbols.map((symbol) => symbol.name);
    expect(names).toEqual(['greet', 'Person', 'constructor', 'sayHi', 'handler']);

    const greet = result.symbols.find((entry) => entry.name === 'greet');
    expect(greet.kind).toBe('function');
    expect(greet.signature).toContain('function greet');
    expect(greet.detail.parameters).toEqual(['name: string']);
    expect(greet.detail.returnType).toBe('string');
    expect(greet.properties.exported).toBe(true);
    expect(greet.properties.async).toBe(true);

    const person = result.symbols.find((entry) => entry.name === 'Person');
    expect(person.kind).toBe('class');
    expect(person.properties.exported).toBe(true);

    const constructorSymbol = result.symbols.find(
      (entry) => entry.name === 'constructor',
    );
    expect(constructorSymbol.kind).toBe('constructor');
    expect(constructorSymbol.properties.source).toBe('class_member');

    const handlerSymbol = result.symbols.find((entry) => entry.name === 'handler');
    expect(handlerSymbol.kind).toBe('function');
    expect(handlerSymbol.properties.declarationKind).toBe('const');
    expect(handlerSymbol.properties.source).toBe('arrow_function');
  });

  it('creates relations between members and their parent types', () => {
    const source = `
      class Widget {
        render() {
          return null;
        }
      }
    `;
    const result = extract(source, 'javascript', '/repo/src/widget.js');
    const relation = result.relations.find(
      (entry) => entry.type === 'belongs_to' && entry.properties.role === 'member',
    );
    expect(relation).toBeDefined();
    const member = result.symbols.find((symbol) => symbol.id === relation.sourceId);
    const parent = result.symbols.find((symbol) => symbol.id === relation.targetId);
    expect(member?.name).toBe('render');
    expect(parent?.name).toBe('Widget');
  });

  it('captures diagnostics when syntax errors are present', () => {
    const source = `
      export function broken( {
        return 1;
      }
    `;
    const result = extract(source, 'javascript', '/repo/src/broken.js');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]).toMatchObject({
      severity: 'error',
    });
  });

  it('parses interface declarations and members', () => {
    const source = `
      export interface Greeter {
        greet(name: string): void;
        readonly id: string;
      }
    `;
    const result = extract(source, 'typescript', '/repo/src/types.ts');
    const interfaceSymbol = result.symbols.find((entry) => entry.name === 'Greeter');
    expect(interfaceSymbol).toBeDefined();
    expect(interfaceSymbol?.kind).toBe('interface');

    const memberNames = result.symbols
      .filter((entry) => entry.properties.source === 'interface_member')
      .map((entry) => entry.name);
    expect(memberNames).toContain('greet');
  });
});
