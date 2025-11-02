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

export const SUPPORTED_LANGUAGES = new Set(['java']);

const createAccumulator = () => ({
  symbols: [],
  relations: [],
  diagnostics: [],
  parentLookup: new Map(),
});

const rememberParent = (accumulator, symbol) => {
  if (!symbol) {
    return;
  }
  const key = symbol.name;
  if (key && !accumulator.parentLookup.has(key)) {
    accumulator.parentLookup.set(key, symbol);
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

const extractIdentifier = (node, source) => {
  if (!node) {
    return undefined;
  }
  const text = sliceText(source, node).trim();
  return text || undefined;
};

const extractModifiers = (node) => {
  const modifiersNode =
    node.childForFieldName?.('modifiers') ??
    node.namedChildren.find((child) => child.type === 'modifiers');
  if (!modifiersNode) {
    return [];
  }
  return modifiersNode.children
    .filter((child) => child && child.isNamed === false)
    .map((child) => child.type);
};

const extractParameters = (node, source) => {
  if (!node) {
    return [];
  }
  const text = sliceText(source, node).trim();
  const stripped = text.replace(/^\(/, '').replace(/\)$/, '');
  if (!stripped) {
    return [];
  }
  return stripped
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const createTypeSymbol = ({
  node,
  kind,
  name,
  filePath,
  language,
  source,
  modifiers = [],
}) => {
  const signatureParts = [`${kind} ${name}`];
  const superclassNode = node.childForFieldName?.('superclass');
  const interfacesNode =
    node.childForFieldName?.('super_interfaces') ??
    node.namedChildren.find((child) => child.type === 'super_interfaces');
  const detail = {};
  if (superclassNode) {
    const extendsText = sliceText(source, superclassNode)
      .replace(/^extends/, '')
      .trim();
    if (extendsText) {
      detail.extends = extendsText;
      signatureParts.push(`extends ${extendsText}`);
    }
  }
  if (interfacesNode) {
    const implementsText = sliceText(source, interfacesNode)
      .replace(/^implements/, '')
      .trim();
    if (implementsText) {
      detail.implements = implementsText.split(',').map((entry) => entry.trim());
      signatureParts.push(`implements ${implementsText}`);
    }
  }
  const signature = signatureParts.join(' ');
  return createSymbolEntity({
    filePath,
    language,
    name,
    kind,
    signature,
    location: nodeToRange(node),
    detail,
    properties: {
      modifiers,
      source: 'type_declaration',
    },
  });
};

const createMethodSymbol = ({
  node,
  name,
  kind,
  filePath,
  language,
  source,
  modifiers = [],
  parentSymbol,
}) => {
  const parametersNode = node.childForFieldName?.('parameters') ??
    node.childForFieldName?.('formal_parameters');
  const returnTypeNode =
    kind === 'constructor'
      ? null
      : node.childForFieldName?.('type') ??
        node.childForFieldName?.('return_type') ??
        node.namedChildren.find((child) => child.type === 'type_identifier');
  const parameters = extractParameters(parametersNode, source);
  const returnType = returnTypeNode
    ? sliceText(source, returnTypeNode).trim()
    : undefined;
  const signatureBase =
    kind === 'constructor'
      ? `${name}(${parameters.join(', ')})`
      : `${returnType ?? 'void'} ${name}(${parameters.join(', ')})`;
  const properties = {
    modifiers,
    source: parentSymbol ? 'class_member' : 'type_member',
  };
  if (parentSymbol) {
    properties.parent = parentSymbol.name;
  }
  return createSymbolEntity({
    filePath,
    language,
    name,
    kind,
    signature: signatureBase,
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

const walkTypeBody = ({
  node,
  source,
  filePath,
  language,
  parentSymbol,
  accumulator,
}) => {
  node.namedChildren.forEach((child) => {
    switch (child.type) {
      case 'method_declaration': {
        const nameNode = child.childForFieldName?.('name') ??
          child.namedChildren.find((named) => named.type === 'identifier');
        const name = extractIdentifier(nameNode, source);
        if (!name) {
          break;
        }
        const modifiers = extractModifiers(child);
        const methodSymbol = createMethodSymbol({
          node: child,
          name,
          kind: 'method',
          filePath,
          language,
          source,
          modifiers,
          parentSymbol,
        });
        registerSymbol(accumulator, methodSymbol);
        if (parentSymbol) {
          accumulator.relations.push(
            createRelationEntity({
              type: 'belongs_to',
              sourceId: methodSymbol.id,
              targetId: parentSymbol.id,
              properties: {
                role: 'member',
              },
            }),
          );
        }
        break;
      }
      case 'constructor_declaration': {
        const nameNode = child.childForFieldName?.('name') ??
          child.namedChildren.find((named) => named.type === 'identifier');
        const name = extractIdentifier(nameNode, source) ?? parentSymbol?.name;
        if (!name) {
          break;
        }
        const modifiers = extractModifiers(child);
        const ctorSymbol = createMethodSymbol({
          node: child,
          name,
          kind: 'constructor',
          filePath,
          language,
          source,
          modifiers,
          parentSymbol,
        });
        registerSymbol(accumulator, ctorSymbol);
        if (parentSymbol) {
          accumulator.relations.push(
            createRelationEntity({
              type: 'belongs_to',
              sourceId: ctorSymbol.id,
              targetId: parentSymbol.id,
              properties: {
                role: 'constructor',
              },
            }),
          );
        }
        break;
      }
      case 'class_declaration':
      case 'interface_declaration': {
        walkAst({
          node: child,
          source,
          filePath,
          language,
          accumulator,
        });
        break;
      }
      default:
        break;
    }
  });
};

const walkAst = ({ node, source, filePath, language, accumulator }) => {
  if (!node) {
    return;
  }
  switch (node.type) {
    case 'program':
    case 'class_body':
    case 'interface_body': {
      node.namedChildren.forEach((child) =>
        walkAst({
          node: child,
          source,
          filePath,
          language,
          accumulator,
        }),
      );
      return;
    }
    case 'class_declaration':
    case 'interface_declaration': {
      const nameNode = node.childForFieldName?.('name') ??
        node.namedChildren.find((child) => child.type === 'identifier');
      const name = extractIdentifier(nameNode, source);
      if (!name) {
        return;
      }
      const modifiers = extractModifiers(node);
      const kind = node.type === 'interface_declaration' ? 'interface' : 'class';
      const typeSymbol = createTypeSymbol({
        node,
        kind,
        name,
        filePath,
        language,
        source,
        modifiers,
      });
      registerSymbol(accumulator, typeSymbol, { remember: true });
      const body =
        node.childForFieldName?.('body') ??
        node.namedChildren.find((child) => child.type.endsWith('_body'));
      if (body) {
        walkTypeBody({
          node: body,
          source,
          filePath,
          language,
          parentSymbol: typeSymbol,
          accumulator,
        });
      }
      return;
    }
    case 'method_declaration':
    case 'constructor_declaration': {
      // Standalone method (unlikely outside body) fallback.
      const nameNode = node.childForFieldName?.('name') ??
        node.namedChildren.find((child) => child.type === 'identifier');
      const name = extractIdentifier(nameNode, source);
      if (!name) {
        return;
      }
      const modifiers = extractModifiers(node);
      const kind = node.type === 'constructor_declaration' ? 'constructor' : 'method';
      const symbol = createMethodSymbol({
        node,
        name,
        kind,
        filePath,
        language,
        source,
        modifiers,
        parentSymbol: null,
      });
      registerSymbol(accumulator, symbol);
      return;
    }
    default: {
      node.namedChildren.forEach((child) =>
        walkAst({
          node: child,
          source,
          filePath,
          language,
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
        message: `Unsupported language "${language}" for java parser.`,
        location: null,
      }),
    );
    return accumulator;
  }
  const tree = parseWithTreeSitter({ language: 'java', source });
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

export const __internals = {
  createAccumulator,
  rememberParent,
  registerSymbol,
  extractIdentifier,
  extractModifiers,
  extractParameters,
  findFirstErrorNode,
  walkTypeBody,
  walkAst,
};
