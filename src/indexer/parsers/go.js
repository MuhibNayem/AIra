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

export const SUPPORTED_LANGUAGES = new Set(['go']);

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

const sanitizeParameters = (text) => {
  if (!text) {
    return [];
  }
  const trimmed = text.trim().replace(/^\(/, '').replace(/\)$/, '');
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const extractParameters = (node, source) => {
  if (!node) {
    return [];
  }
  return sanitizeParameters(sliceText(source, node));
};

const extractResultType = (node, source) => {
  if (!node) {
    return undefined;
  }
  const text = sliceText(source, node).trim();
  return text || undefined;
};

const extractReceiverInfo = (node, source) => {
  if (!node) {
    return { raw: null, typeName: null };
  }
  const raw = sliceText(source, node).trim();
  if (!raw) {
    return { raw: null, typeName: null };
  }
  const match = raw.match(/[*\s]*([A-Za-z_][\w]*)\s*\)?$/);
  return {
    raw,
    typeName: match ? match[1] : null,
  };
};

const createTypeSymbol = ({
  name,
  node,
  filePath,
  language,
  source,
  typeKind,
}) => {
  const signature = `type ${name} ${typeKind}`;
  return createSymbolEntity({
    filePath,
    language,
    name,
    kind: typeKind === 'interface' ? 'interface' : 'struct',
    signature,
    location: nodeToRange(node),
    detail: {},
    properties: {
      source: 'type_declaration',
      rawType: sliceText(source, node).trim(),
    },
  });
};

const createFunctionSymbol = ({
  kind,
  name,
  parameters,
  result,
  node,
  filePath,
  language,
  source,
  receiver,
}) => {
  const exported = /^[A-Z]/.test(name);
  const signatureParts = [];
  if (receiver?.raw) {
    signatureParts.push(`func ${receiver.raw} ${name}(${parameters.join(', ')})`);
  } else {
    signatureParts.push(`func ${name}(${parameters.join(', ')})`);
  }
  if (result) {
    signatureParts[0] = `${signatureParts[0]} ${result}`;
  }
  const properties = {
    exported,
    receiver: receiver?.raw ?? null,
    receiverType: receiver?.typeName ?? null,
    source: receiver?.raw ? 'method' : 'function',
  };
  return createSymbolEntity({
    filePath,
    language,
    name,
    kind,
    signature: signatureParts.join(''),
    location: nodeToRange(node),
    detail: {
      parameters,
      returnType: result,
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

const handleTypeDeclaration = ({
  node,
  source,
  filePath,
  language,
  accumulator,
}) => {
  node.namedChildren.forEach((child) => {
    if (child.type !== 'type_spec') {
      return;
    }
    const nameNode = child.namedChildren.find(
      (namedChild) => namedChild.type === 'type_identifier',
    );
    const typeNode = child.namedChildren.find(
      (namedChild) =>
        namedChild !== nameNode &&
        ['struct_type', 'interface_type'].includes(namedChild.type),
    );
    const name = extractIdentifier(nameNode, source);
    if (!name || !typeNode) {
      return;
    }
    const typeKind = typeNode.type === 'interface_type' ? 'interface' : 'struct';
    const typeSymbol = createTypeSymbol({
      name,
      node: typeNode,
      filePath,
      language,
      source,
      typeKind,
    });
    registerSymbol(accumulator, typeSymbol, { remember: true });
  });
};

const handleMethodDeclaration = ({
  node,
  source,
  filePath,
  language,
  accumulator,
}) => {
  const receiverNode = node.namedChildren.find(
    (child) => child.type === 'parameter_list',
  );
  const paramsNodes = node.namedChildren.filter(
    (child) =>
      child.type === 'parameter_list' && child !== receiverNode,
  );
  const parametersNode = paramsNodes[0];
  const resultNode = node.childForFieldName('result');
  const result =
    extractResultType(resultNode, source) ??
    node.namedChildren
      .filter(
        (child) =>
          child !== receiverNode &&
          child !== parametersNode &&
          !child.children?.length &&
          child.isNamed,
      )
      .map((child) => sliceText(source, child).trim())
      .find(Boolean);
  const receiver = extractReceiverInfo(receiverNode, source);
  const nameNode = node.namedChildren.find(
    (child) => child.type === 'field_identifier' || child.type === 'identifier',
  );
  const name = extractIdentifier(nameNode, source);
  if (!name) {
    return;
  }
  const parameters = extractParameters(parametersNode, source);
  const symbol = createFunctionSymbol({
    kind: 'method',
    name,
    parameters,
    result,
    node,
    filePath,
    language,
    source,
    receiver,
  });
  registerSymbol(accumulator, symbol);
  if (receiver?.typeName) {
    const parent =
      accumulator.parentLookup.get(receiver.typeName) ?? null;
    if (parent) {
      accumulator.relations.push(
        createRelationEntity({
          type: 'belongs_to',
          sourceId: symbol.id,
          targetId: parent.id,
          properties: {
            role: 'method',
            receiver: receiver.raw,
          },
        }),
      );
    }
  }
};

const handleFunctionDeclaration = ({
  node,
  source,
  filePath,
  language,
  accumulator,
}) => {
  const nameNode = node.childForFieldName('name') ??
    node.namedChildren.find((child) => child.type === 'identifier');
  const name = extractIdentifier(nameNode, source);
  if (!name) {
    return;
  }
  const parametersNode = node.childForFieldName('parameters');
  const resultNode = node.childForFieldName('result');
  const parameters = extractParameters(parametersNode, source);
  const result = extractResultType(resultNode, source);
  const symbol = createFunctionSymbol({
    kind: 'function',
    name,
    parameters,
    result,
    node,
    filePath,
    language,
    source,
    receiver: null,
  });
  registerSymbol(accumulator, symbol);
};

const walkAst = ({ node, source, filePath, language, accumulator }) => {
  if (!node) {
    return;
  }
  switch (node.type) {
    case 'source_file':
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
    case 'type_declaration':
      handleTypeDeclaration({ node, source, filePath, language, accumulator });
      return;
    case 'method_declaration':
      handleMethodDeclaration({ node, source, filePath, language, accumulator });
      return;
    case 'function_declaration':
      handleFunctionDeclaration({
        node,
        source,
        filePath,
        language,
        accumulator,
      });
      return;
    default:
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
};

export const extractSymbolsFromSource = ({ source, filePath, language }) => {
  const accumulator = createAccumulator();
  if (!SUPPORTED_LANGUAGES.has(`${language}`.toLowerCase())) {
    accumulator.diagnostics.push(
      createDiagnostic({
        severity: 'warning',
        message: `Unsupported language "${language}" for go parser.`,
        location: null,
      }),
    );
    return accumulator;
  }

  const tree = parseWithTreeSitter({ language: 'go', source });
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
