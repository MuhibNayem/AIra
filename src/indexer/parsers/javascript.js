import { promises as fs } from 'fs';
import {
  parseWithTreeSitter,
  nodeToRange,
  sliceText,
  supportedTreeSitterLanguages,
} from './tree-sitter.js';
import {
  createSymbolEntity,
  createRelationEntity,
  createDiagnostic,
} from './normalizer.js';

export const SUPPORTED_LANGUAGES = new Set(supportedTreeSitterLanguages());

const MODIFIER_TOKENS = new Set([
  'async',
  'static',
  'public',
  'private',
  'protected',
  'abstract',
  'readonly',
  'declare',
  'default',
  'export',
  'get',
  'set',
]);

const DECLARATION_KEYWORDS = new Set(['const', 'let', 'var']);

const FUNCTION_NODE_TYPES = new Set([
  'function',
  'function_declaration',
  'generator_function',
  'generator_function_declaration',
  'function_expression',
  'arrow_function',
]);

const CLASS_NODE_TYPES = new Set(['class', 'class_declaration']);

const stripParentheses = (value) => value.replace(/^\(/, '').replace(/\)$/, '');

const extractParameters = (paramsNode, source) => {
  if (!paramsNode) {
    return [];
  }
  if (paramsNode.type === 'identifier') {
    return [sliceText(source, paramsNode).trim()].filter(Boolean);
  }
  const raw = sliceText(source, paramsNode).trim();
  if (!raw) {
    return [];
  }
  const withoutParens = stripParentheses(raw);
  return withoutParens
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const extractReturnType = (node, source) => {
  if (!node) {
    return undefined;
  }
  const text = sliceText(source, node).trim();
  if (!text) {
    return undefined;
  }
  return text.replace(/^:\s*/, '');
};

const extractModifiers = (node) =>
  node.children
    .filter(
      (child) => child && !child.isNamed && MODIFIER_TOKENS.has(child.type),
    )
    .map((child) => child.type);

const hasModifier = (node, modifier) => extractModifiers(node).includes(modifier);

const resolveIdentifierText = (node, source) => {
  if (!node) {
    return undefined;
  }
  const text = sliceText(source, node).trim();
  return text || undefined;
};

const buildFunctionSignature = ({
  name,
  parameters,
  returnType,
  prefix = 'function',
}) => {
  const paramList = parameters.join(', ');
  const signature = `${prefix} ${name}(${paramList})`.trim();
  if (returnType) {
    return `${signature}: ${returnType}`;
  }
  return signature;
};

const createFunctionSymbol = ({
  node,
  name,
  filePath,
  language,
  source,
  context,
  prefix,
}) => {
  const parametersNode =
    node.childForFieldName('parameters') ?? node.childForFieldName('signature');
  const parameters = extractParameters(parametersNode, source);
  const returnType = extractReturnType(
    node.childForFieldName('return_type'),
    source,
  );
  const asyncFlag = hasModifier(node, 'async');
  const generatorFlag =
    node.type.includes('generator') || hasModifier(node, 'generator');
  const signature = buildFunctionSignature({
    name,
    parameters,
    returnType,
    prefix,
  });
  const location = nodeToRange(node);
  const detail = {
    parameters,
  };
  if (returnType) {
    detail.returnType = returnType;
  }
  const modifiers = extractModifiers(node);
  const properties = {
    exported: context.exported ?? false,
    defaultExport: context.defaultExport ?? false,
    async: asyncFlag,
    generator: generatorFlag,
    modifiers,
    source: context.sourceKind ?? 'declaration',
  };

  return createSymbolEntity({
    filePath,
    language,
    name,
    kind: 'function',
    signature,
    location,
    detail,
    properties,
  });
};

const createClassSymbol = ({
  node,
  name,
  filePath,
  language,
  source,
  context,
}) => {
  const heritage =
    node.childForFieldName('superclass') ??
    node.childForFieldName('extends') ??
    node.childForFieldName('heritage');
  const implemented =
    node.childForFieldName('implements') ??
    node.childForFieldName('interface_clause');
  const detail = {};
  if (heritage) {
    detail.extends = sliceText(source, heritage).trim();
  }
  if (implemented) {
    detail.implements = sliceText(source, implemented).trim();
  }
  const modifiers = extractModifiers(node);
  const properties = {
    exported: context.exported ?? false,
    defaultExport: context.defaultExport ?? false,
    modifiers,
  };
  return createSymbolEntity({
    filePath,
    language,
    name,
    kind: 'class',
    signature: `class ${name}`,
    location: nodeToRange(node),
    detail,
    properties,
  });
};

const createInterfaceSymbol = ({
  node,
  name,
  filePath,
  language,
  source,
  context,
}) => {
  const heritage =
    node.childForFieldName('extends') ?? node.childForFieldName('heritage');
  const detail = {};
  if (heritage) {
    detail.extends = sliceText(source, heritage).trim();
  }

  const modifiers = extractModifiers(node);
  const properties = {
    exported: context.exported ?? false,
    defaultExport: context.defaultExport ?? false,
    modifiers,
  };

  return createSymbolEntity({
    filePath,
    language,
    name,
    kind: 'interface',
    signature: `interface ${name}`,
    location: nodeToRange(node),
    detail,
    properties,
  });
};

const createMethodSymbol = ({
  node,
  name,
  filePath,
  language,
  source,
  context,
  kind = 'method',
}) => {
  const parametersNode =
    node.childForFieldName('parameters') ?? node.childForFieldName('signature');
  const parameters = extractParameters(parametersNode, source);
  const returnType = extractReturnType(
    node.childForFieldName('return_type'),
    source,
  );
  const modifiers = extractModifiers(node);
  const asyncFlag = modifiers.includes('async');
  const staticFlag = modifiers.includes('static');
  const properties = {
    exported: context.exported ?? false,
    defaultExport: context.defaultExport ?? false,
    async: asyncFlag,
    static: staticFlag,
    access:
      modifiers.find((modifier) =>
        ['public', 'private', 'protected'].includes(modifier),
      ) ?? null,
    modifiers,
    source: context.sourceKind ?? 'member',
  };
  const signature = buildFunctionSignature({
    name,
    parameters,
    returnType,
    prefix: kind === 'constructor' ? 'constructor' : 'method',
  });
  const detail = {
    parameters,
  };
  if (returnType) {
    detail.returnType = returnType;
  }
  return createSymbolEntity({
    filePath,
    language,
    name,
    kind,
    signature,
    location: nodeToRange(node),
    detail,
    properties,
  });
};

const resolveDeclarationKind = (node) => {
  const keywordNode = node.children.find(
    (child) => child && !child.isNamed && DECLARATION_KEYWORDS.has(child.type),
  );
  return keywordNode ? keywordNode.type : undefined;
};

const handleFunctionDeclarator = ({
  node,
  name,
  filePath,
  language,
  source,
  context,
  accumulator,
}) => {
  if (!name) {
    return;
  }
  const symbol = createFunctionSymbol({
    node,
    name,
    filePath,
    language,
    source,
    context,
    prefix: context.sourceKind === 'variable' ? 'function' : 'function',
  });
  accumulator.symbols.push(symbol);
};

const handleVariableDeclarator = ({
  node,
  filePath,
  language,
  source,
  context,
  accumulator,
  declarationKind,
}) => {
  const nameNode = node.childForFieldName('name');
  const valueNode = node.childForFieldName('value');
  if (!nameNode || !valueNode) {
    return;
  }
  const name = resolveIdentifierText(nameNode, source);
  if (!name) {
    return;
  }
  const sourceKind =
    valueNode.type === 'class'
      ? 'class_expression'
      : valueNode.type === 'generator_function'
        ? 'generator_function_expression'
        : valueNode.type === 'function_expression'
          ? 'function_expression'
          : valueNode.type === 'arrow_function'
            ? 'arrow_function'
            : valueNode.type;

  const valueContext = {
    ...context,
    sourceKind: sourceKind.startsWith('class') ? 'class_expression' : 'variable',
  };

  if (CLASS_NODE_TYPES.has(valueNode.type)) {
    const symbol = createClassSymbol({
      node: valueNode,
      name,
      filePath,
      language,
      source,
      context: {
        ...context,
        sourceKind: 'class_expression',
      },
    });
    symbol.properties.declarationKind = declarationKind;
    accumulator.symbols.push(symbol);
    return;
  }

  if (!FUNCTION_NODE_TYPES.has(valueNode.type)) {
    return;
  }

  const symbol = createFunctionSymbol({
    node: valueNode,
    name,
    filePath,
    language,
    source,
    context: {
      ...valueContext,
      sourceKind: 'variable',
    },
    prefix: 'function',
  });
  symbol.properties.declarationKind = declarationKind;
  symbol.properties.source = sourceKind;
  accumulator.symbols.push(symbol);
};

const handleMethodLikeNode = ({
  node,
  filePath,
  language,
  source,
  context,
  accumulator,
  defaultKind = 'method',
}) => {
  const nameNode =
    node.childForFieldName('name') ??
    node.childForFieldName('key') ??
    node.namedChildren.find((child) =>
      ['property_identifier', 'identifier', 'private_property_identifier'].includes(
        child.type,
      ),
    );
  const propertyName = resolveIdentifierText(nameNode, source) ?? '<anonymous>';
  const modifiers = extractModifiers(node);
  let methodKind = defaultKind;
  if (propertyName === 'constructor' || defaultKind === 'constructor') {
    methodKind = 'constructor';
  } else if (modifiers.includes('get')) {
    methodKind = 'getter';
  } else if (modifiers.includes('set')) {
    methodKind = 'setter';
  }

  const symbol = createMethodSymbol({
    node,
    name: propertyName,
    filePath,
    language,
    source,
    context,
    kind: methodKind,
  });
  accumulator.symbols.push(symbol);

  if (context.parentSymbol) {
    accumulator.relations.push(
      createRelationEntity({
        type: 'belongs_to',
        sourceId: symbol.id,
        targetId: context.parentSymbol.id,
        properties: {
          role: 'member',
        },
      }),
    );
  }
};

const walkAst = ({
  node,
  source,
  filePath,
  language,
  context,
  accumulator,
}) => {
  switch (node.type) {
    case 'export_statement': {
      const isDefaultExport = node.children.some(
        (child) => child.type === 'default',
      );
      const exportContext = {
        ...context,
        exported: true,
        defaultExport: isDefaultExport,
      };
      node.namedChildren.forEach((child) => {
        if (child.type === 'export_clause') {
          return;
        }
        if (child.type === 'identifier') {
          accumulator.diagnostics.push(
            createDiagnostic({
              message: `Unsupported re-export encountered: ${sliceText(source, child)}`,
              severity: 'info',
              location: nodeToRange(child),
            }),
          );
          return;
        }
        walkAst({
          node: child,
          source,
          filePath,
          language,
          context: exportContext,
          accumulator,
        });
      });
      return;
    }

    case 'class_declaration': {
      const nameNode =
        node.childForFieldName('name') ??
        node.namedChildren.find((child) => child.type === 'identifier');
      const className =
        resolveIdentifierText(nameNode, source) ?? (context.defaultExport ? 'default' : '<anonymous>');
      const classSymbol = createClassSymbol({
        node,
        name: className,
        filePath,
        language,
        source,
        context,
      });
      accumulator.symbols.push(classSymbol);
      const body = node.childForFieldName('body');
      if (body) {
        body.namedChildren.forEach((child) => {
          if (child.type === 'method_definition' || child.type === 'method_signature') {
            walkAst({
              node: child,
              source,
              filePath,
              language,
              context: {
                exported: false,
                defaultExport: false,
                parentSymbol: classSymbol,
                sourceKind: 'class_member',
              },
              accumulator,
            });
            return;
          }
          if (child.type === 'class_body') {
            walkAst({
              node: child,
              source,
              filePath,
              language,
              context: {
                exported: false,
                defaultExport: false,
                parentSymbol: classSymbol,
                sourceKind: 'class_member',
              },
              accumulator,
            });
          }
        });
      }
      return;
    }

    case 'interface_declaration': {
      const nameNode =
        node.childForFieldName('name') ??
        node.namedChildren.find((child) => child.type === 'identifier');
      const interfaceName =
        resolveIdentifierText(nameNode, source) ??
        (context.defaultExport ? 'default' : '<anonymous>');
      const interfaceSymbol = createInterfaceSymbol({
        node,
        name: interfaceName,
        filePath,
        language,
        source,
        context,
      });
      accumulator.symbols.push(interfaceSymbol);

      const body = node.childForFieldName('body');
      if (body) {
        body.namedChildren.forEach((child) => {
          if (child.type === 'method_signature') {
            walkAst({
              node: child,
              source,
              filePath,
              language,
              context: {
                exported: false,
                defaultExport: false,
                parentSymbol: interfaceSymbol,
                sourceKind: 'interface_member',
              },
              accumulator,
            });
          }
        });
      }
      return;
    }

    case 'function_declaration':
    case 'generator_function_declaration': {
      const nameNode =
        node.childForFieldName('name') ??
        node.namedChildren.find((child) => child.type === 'identifier');
      const functionName =
        resolveIdentifierText(nameNode, source) ??
        (context.defaultExport ? 'default' : '<anonymous>');
      handleFunctionDeclarator({
        node,
        name: functionName,
        filePath,
        language,
        source,
        context,
        accumulator,
      });
      return;
    }

    case 'lexical_declaration':
    case 'variable_declaration': {
      const declarationKind = resolveDeclarationKind(node);
      node.namedChildren.forEach((child) => {
        if (child.type === 'variable_declarator') {
          handleVariableDeclarator({
            node: child,
            filePath,
            language,
            source,
            context,
            accumulator,
            declarationKind,
          });
        }
      });
      return;
    }

    case 'method_definition': {
      handleMethodLikeNode({
        node,
        filePath,
        language,
        source,
        context,
        accumulator,
        defaultKind: 'method',
      });
      return;
    }

    case 'method_signature': {
      handleMethodLikeNode({
        node,
        filePath,
        language,
        source,
        context,
        accumulator,
        defaultKind: 'method',
      });
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

export const extractSymbolsFromSource = ({ source, filePath, language }) => {
  const accumulator = {
    symbols: [],
    relations: [],
    diagnostics: [],
  };

  if (!SUPPORTED_LANGUAGES.has(`${language}`.toLowerCase())) {
    accumulator.diagnostics.push(
      createDiagnostic({
        severity: 'warning',
        message: `Unsupported language "${language}" for tree-sitter parsing.`,
        location: null,
      }),
    );
    return accumulator;
  }

  const tree = parseWithTreeSitter({ language, source });
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
      exported: false,
      defaultExport: false,
      parentSymbol: null,
      sourceKind: 'root',
    },
    accumulator,
  });

  return accumulator;
};

export const extractSymbols = async ({ filePath, language }) => {
  const content = await fs.readFile(filePath, 'utf-8');
  return extractSymbolsFromSource({ source: content, filePath, language });
};
