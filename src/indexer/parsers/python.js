import { promises as fs } from 'fs';
import {
  parseWithTreeSitter,
  nodeToRange,
  sliceText,
} from './tree-sitter.js';
import {
  createSymbolEntity,
  createRelationEntity,
  createDiagnostic,
} from './normalizer.js';

export const SUPPORTED_LANGUAGES = new Set(['python']);

const createAccumulator = () => ({
  symbols: [],
  relations: [],
  diagnostics: [],
  parentLookup: new Map(),
});

const rememberParent = (accumulator, symbol) => {
  if (symbol && ['class', 'interface'].includes(symbol.kind)) {
    const key = symbol.name;
    if (key && !accumulator.parentLookup.has(key)) {
      accumulator.parentLookup.set(key, symbol);
    }
  }
};

const registerSymbol = (accumulator, symbol, { remember = false } = {}) => {
  if (!symbol) {
    return;
  }
  accumulator.symbols.push(symbol);
  if (remember) {
    rememberParent(accumulator, symbol);
  }
};

const cleanParameters = (raw) => {
  if (!raw) {
    return [];
  }
  const normalized = raw.trim().replace(/^\(/, '').replace(/\)$/, '');
  if (!normalized) {
    return [];
  }
  return normalized
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const extractParameters = (node, source) => {
  if (!node) {
    return [];
  }
  return cleanParameters(sliceText(source, node));
};

const extractReturnType = (node, source) => {
  if (!node) {
    return undefined;
  }
  const text = sliceText(source, node).trim();
  if (!text) {
    return undefined;
  }
  return text;
};

const extractIdentifier = (node, source) => {
  if (!node) {
    return undefined;
  }
  const text = sliceText(source, node).trim();
  return text || undefined;
};

const extractDecoratorNames = (decorators, source) =>
  decorators
    .map((decorator) => sliceText(source, decorator).replace(/^@/, '').trim())
    .filter(Boolean);

const createClassSymbol = ({
  node,
  name,
  filePath,
  language,
  source,
  decorators = [],
}) => {
  const argumentsNode = node.namedChildren.find(
    (child) => child.type === 'argument_list',
  );
  const bases = argumentsNode
    ? cleanParameters(sliceText(source, argumentsNode))
    : [];
  const signature =
    bases.length > 0 ? `class ${name}(${bases.join(', ')})` : `class ${name}`;
  const properties = {
    decorators,
    source: 'class',
  };
  return createSymbolEntity({
    filePath,
    language,
    name,
    kind: 'class',
    signature,
    location: nodeToRange(node),
    detail: { bases },
    properties,
  });
};

const createFunctionSymbol = ({
  node,
  name,
  filePath,
  language,
  source,
  decorators = [],
  parentSymbol,
}) => {
  const parametersNode = node.childForFieldName('parameters');
  const returnTypeNode = node.childForFieldName('return_type');
  const parameters = extractParameters(parametersNode, source);
  const returnType = extractReturnType(returnTypeNode, source);
  const asyncFlag = node.children.some((child) => child.type === 'async');
  const kind = parentSymbol ? 'method' : 'function';
  const prefix = kind === 'method' ? 'def' : 'def';
  const signatureBase = `${prefix} ${name}(${parameters.join(', ')})`;
  const signature =
    returnType && returnType.length
      ? `${signatureBase} -> ${returnType}`
      : signatureBase;
  const properties = {
    decorators,
    async: asyncFlag,
    source: parentSymbol ? 'class_member' : 'module',
  };
  if (parentSymbol) {
    properties.parent = parentSymbol.name;
  }
  return createSymbolEntity({
    filePath,
    language,
    name,
    kind,
    signature,
    location: nodeToRange(node),
    detail: {
      parameters,
      returnType,
    },
    properties,
  });
};

const findFirstErrorNode = (node) => {
  if (!node) {
    return null;
  }
  if (node.type === 'ERROR') {
    return node;
  }
  for (const child of node.namedChildren) {
    const match = findFirstErrorNode(child);
    if (match) {
      return match;
    }
  }
  return null;
};

const walkAst = ({ node, source, filePath, language, context, accumulator }) => {
  if (!node) {
    return;
  }
  switch (node.type) {
    case 'module':
    case 'block':
    case 'suite': {
      node.namedChildren.forEach((child) =>
        walkAst({
          node: child,
          source,
          filePath,
          language,
          context,
          accumulator,
        }),
      );
      return;
    }
    case 'decorated_definition': {
      const decorators = node.namedChildren.filter(
        (child) => child.type === 'decorator',
      );
      const decoratorNames = extractDecoratorNames(decorators, source);
      const definition = node.namedChildren.find((child) =>
        ['class_definition', 'function_definition'].includes(child.type),
      );
      if (definition) {
        walkAst({
          node: definition,
          source,
          filePath,
          language,
          context: {
            ...context,
            decorators: decoratorNames,
          },
          accumulator,
        });
      }
      return;
    }
    case 'class_definition': {
      const nameNode = node.childForFieldName('name');
      const name =
        extractIdentifier(nameNode, source) ??
        (context.decorators?.length ? context.decorators.join('_') : '<anonymous>');
      const classSymbol = createClassSymbol({
        node,
        name,
        filePath,
        language,
        source,
        decorators: context.decorators ?? [],
      });
      registerSymbol(accumulator, classSymbol, { remember: true });
      const body = node.childForFieldName('body');
      if (body) {
        body.namedChildren.forEach((child) =>
          walkAst({
            node: child,
            source,
            filePath,
            language,
            context: {
              parentSymbol: classSymbol,
              decorators: [],
            },
            accumulator,
          }),
        );
      }
      return;
    }
    case 'function_definition': {
      const nameNode = node.childForFieldName('name');
      const name =
        extractIdentifier(nameNode, source) ??
        (context.decorators?.length ? context.decorators.join('_') : '<anonymous>');
      const functionSymbol = createFunctionSymbol({
        node,
        name,
        filePath,
        language,
        source,
        decorators: context.decorators ?? [],
        parentSymbol: context.parentSymbol,
      });
      registerSymbol(accumulator, functionSymbol);
      if (context.parentSymbol) {
        accumulator.relations.push(
          createRelationEntity({
            type: 'belongs_to',
            sourceId: functionSymbol.id,
            targetId: context.parentSymbol.id,
            properties: {
              role: 'member',
            },
          }),
        );
      }
      return;
    }
    default: {
      node.namedChildren.forEach((child) =>
        walkAst({
          node: child,
          source,
          filePath,
          language,
          context,
          accumulator,
        }),
      );
    }
  }
};

export const extractSymbolsFromSource = ({ source, filePath, language }) => {
  const accumulator = createAccumulator();
  if (!SUPPORTED_LANGUAGES.has(`${language}`.toLowerCase())) {
    accumulator.diagnostics.push(
      createDiagnostic({
        severity: 'warning',
        message: `Unsupported language "${language}" for python parser.`,
        location: null,
      }),
    );
    return accumulator;
  }
  const tree = parseWithTreeSitter({ language: 'python', source });
  if (!tree) {
    accumulator.diagnostics.push(
      createDiagnostic({
        severity: 'error',
        message: `Tree-sitter failed to parse ${filePath}.`,
        location: null,
      }),
    );
    return accumulator;
  }
  if (tree.rootNode.hasError) {
    const fault = findFirstErrorNode(tree.rootNode) ?? tree.rootNode;
    accumulator.diagnostics.push(
      createDiagnostic({
        severity: 'error',
        message: `Tree-sitter detected syntax errors while parsing ${filePath}.`,
        location: nodeToRange(fault),
      }),
    );
  }

  walkAst({
    node: tree.rootNode,
    source,
    filePath,
    language,
    context: {
      decorators: [],
      parentSymbol: null,
    },
    accumulator,
  });

  return accumulator;
};

export const extractSymbols = async ({ filePath, language }) => {
  const content = await fs.readFile(filePath, 'utf-8');
  const result = extractSymbolsFromSource({
    source: content,
    filePath,
    language,
  });
  return {
    symbols: result.symbols,
    relations: result.relations,
    diagnostics: result.diagnostics,
  };
};
