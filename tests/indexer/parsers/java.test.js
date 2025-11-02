import { describe, it, expect } from 'vitest';
import { extractSymbolsFromSource, __internals as javaInternals } from '../../../src/indexer/parsers/java.js';

const extract = (source, filePath = '/repo/src/Person.java') =>
  extractSymbolsFromSource({
    source,
    filePath,
    language: 'java',
  });

describe('java parser (tree-sitter)', () => {
  it('extracts classes, constructors, methods, and relations', () => {
    const source = `
package demo;

public class Person extends Base implements Named, Serializable {
  private final String name;

  public Person(String name) {
    this.name = name;
  }

  public String greet(int times) {
    return "hi";
  }

  class Friend {
    void wave() {}
  }

  interface Local {
    void speak();
  }
}

public interface Greeter {
  String greet();
}
`;
    const result = extract(source);
    const names = result.symbols.map((symbol) => symbol.name);
    expect(new Set(names)).toEqual(
      new Set(['Person', 'greet', 'Greeter', 'Friend', 'wave', 'Local', 'speak']),
    );

    const classSymbol = result.symbols[0];
    expect(classSymbol.kind).toBe('class');
    expect(classSymbol.detail.extends).toBe('Base');
    expect(classSymbol.detail.implements).toEqual(['Named', 'Serializable']);
    expect(classSymbol.properties.modifiers).toContain('public');

    const ctor = result.symbols.find(
      (entry) => entry.name === 'Person' && entry.kind === 'constructor',
    );
    expect(ctor).toBeDefined();
    expect(ctor?.detail.parameters).toEqual(['String name']);

    const greet = result.symbols.find((entry) => entry.name === 'greet');
    expect(greet.kind).toBe('method');
    expect(greet.detail.returnType).toBe('String');
    expect(greet.detail.parameters).toEqual(['int times']);

    const greeter = result.symbols.find((entry) => entry.name === 'Greeter');
    expect(greeter.kind).toBe('interface');
    const interfaceMethod = result.symbols.find(
      (entry) =>
        entry.name === 'greet' && entry.kind === 'method' && entry.properties.parent === 'Greeter',
    );
    expect(interfaceMethod).toBeDefined();

    const friend = result.symbols.find((entry) => entry.name === 'Friend');
    expect(friend).toBeDefined();
    const wave = result.symbols.find(
      (entry) => entry.name === 'wave' && entry.properties.parent === 'Friend',
    );
    expect(wave).toBeDefined();

    const relation = result.relations.find(
      (entry) => entry.sourceId === greet.id && entry.type === 'belongs_to',
    );
    expect(relation).toBeDefined();
    expect(relation.targetId).toBe(classSymbol.id);
  });

  it('records diagnostics when parsing fails', () => {
    const source = `
public class Broken {
  public void bad( {
}
`;
    const result = extract(source, '/repo/src/Broken.java');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0].severity).toBe('error');
  });
});

describe('java parser internals', () => {
  it('returns warning when language unsupported', () => {
    const result = extractSymbolsFromSource({
      source: 'class Unknown {}',
      filePath: '/repo/src/Unknown.java',
      language: 'scala',
    });
    expect(result.diagnostics[0]).toMatchObject({ severity: 'warning' });
  });

  it('exposes helper utilities for edge cases', () => {
    const accumulator = javaInternals.createAccumulator();
    javaInternals.registerSymbol(accumulator, undefined);
    expect(accumulator.symbols).toHaveLength(0);

    javaInternals.rememberParent(accumulator, undefined);
    javaInternals.rememberParent(accumulator, { name: 'Person' });
    javaInternals.rememberParent(accumulator, { name: 'Person' });
    expect(accumulator.parentLookup.get('Person')).toBeDefined();

    const modifiersNode = {
      children: [
        { type: 'public', isNamed: false },
        { type: 'static', isNamed: false },
      ],
    };
    const modifierTarget = {
      childForFieldName: (field) => (field === 'modifiers' ? modifiersNode : null),
      namedChildren: [],
    };
    expect(javaInternals.extractModifiers(modifierTarget)).toEqual(['public', 'static']);

    const fallbackTarget = {
      childForFieldName: () => undefined,
      namedChildren: [
        {
          type: 'modifiers',
          children: [{ type: 'private', isNamed: false }],
        },
      ],
    };
    expect(javaInternals.extractModifiers(fallbackTarget)).toEqual(['private']);

    expect(javaInternals.extractIdentifier(null, 'class Test {}')).toBeUndefined();

    const paramSource = '(String name, int count)';
    const paramNode = { startIndex: 0, endIndex: paramSource.length };
    expect(javaInternals.extractParameters(paramNode, paramSource)).toEqual([
      'String name',
      'int count',
    ]);
    expect(javaInternals.extractParameters(null, paramSource)).toEqual([]);

    const errorNode = {
      type: 'program',
      namedChildren: [
        {
          type: 'class_declaration',
          namedChildren: [{ type: 'ERROR', namedChildren: [] }],
        },
      ],
    };
    expect(javaInternals.findFirstErrorNode(errorNode)?.type).toBe('ERROR');
  });
});
