import path from 'path';
import { listFiles, listSymbols, listRelations, getSymbolById, searchFileContent } from './storage/sqlite.js';
import { getAllowedReadRoots, ensureReadAllowed } from '../utils/security.js';
import { readFile as fsReadFile } from '../tools/file_system.js';
import { __internals as metadataInternals } from './metadata.js';

const resolveIndexRoot = (indexRoot) => {
  const candidate =
    indexRoot && typeof indexRoot === 'string' ? indexRoot.trim() : '';
  if (candidate) {
    const normalized = path.resolve(candidate);
    const basename = path.basename(normalized);
    const parent = path.basename(path.dirname(normalized));
    if (basename === 'index' && parent === '.aira') {
      return normalized;
    }
    return metadataInternals.resolveIndexRoot(normalized);
  }
  return metadataInternals.resolveIndexRoot(process.cwd());
};

export const getIndexedFiles = async (indexRoot) => {
  const resolvedRoot = resolveIndexRoot(indexRoot);
  const readRoots = getAllowedReadRoots();
  return listFiles(resolvedRoot, { readRoots });
};

export const getIndexedSymbols = async (indexRoot, options = {}) => {
  const resolvedRoot = resolveIndexRoot(indexRoot);
  const readRoots = getAllowedReadRoots();
  const { name, kind, filePath, limit } = options;
  return listSymbols(resolvedRoot, { readRoots, name, kind, filePath, limit });
};

export const getIndexedRelations = async (indexRoot, options = {}) => {
  const resolvedRoot = resolveIndexRoot(indexRoot);
  const readRoots = getAllowedReadRoots();
  const { kind, sourceSymbolId, targetSymbolId, limit } = options;
  return listRelations(resolvedRoot, { ...options, readRoots, kind, sourceSymbolId, targetSymbolId, limit });
};

export const getSymbolDetailsById = async (indexRoot, symbolId) => {
  const resolvedRoot = resolveIndexRoot(indexRoot);
  const readRoots = getAllowedReadRoots();
  return getSymbolById(resolvedRoot, symbolId, { readRoots });
};

export const getFileContent = async (indexRoot, filePath) => {
  return fsReadFile(filePath);
};

export const getSymbolsInFile = async (indexRoot, filePath, options = {}) => {
  const resolvedRoot = resolveIndexRoot(indexRoot);
  const readRoots = getAllowedReadRoots();
  ensureReadAllowed(filePath);
  const { name, kind, limit } = options;
  return listSymbols(resolvedRoot, { readRoots, name, kind, filePath, limit });
};

export const getRelationsForSymbol = async (indexRoot, symbolId, options = {}) => {
  const resolvedRoot = resolveIndexRoot(indexRoot);
  const readRoots = getAllowedReadRoots();
  const { kind, direction, limit } = options;
  let relations = [];

  if (direction === 'source' || direction === 'both') {
    const sourceRelations = await listRelations(resolvedRoot, { readRoots, kind, sourceSymbolId: symbolId, limit });
    relations.push(...sourceRelations);
  }
  if (direction === 'target' || direction === 'both') {
    const targetRelations = await listRelations(resolvedRoot, { readRoots, kind, targetSymbolId: symbolId, limit });
    relations.push(...targetRelations);
  }
  if (!direction) {
    relations = await listRelations(resolvedRoot, { readRoots, kind, sourceSymbolId: symbolId, targetSymbolId: symbolId, limit });
  }
  return relations;
};

export const searchCode = async (indexRoot, options = {}) => {
  const resolvedRoot = resolveIndexRoot(indexRoot);
  const readRoots = getAllowedReadRoots();
  const { query, filePathPattern, language, limit } = options;
  return searchFileContent(resolvedRoot, { query, filePathPattern, language, readRoots, limit });
};

export const getDefinition = async (indexRoot, symbolId) => {
  const resolvedRoot = resolveIndexRoot(indexRoot);
  const symbol = await getSymbolDetailsById(resolvedRoot, symbolId);
  if (!symbol) {
    return null;
  }
  const fileContent = await getFileContent(resolvedRoot, symbol.filePath);
  const lines = fileContent.split('\n');

  const startLine = symbol.metadata?.location?.start?.line;
  const endLine = symbol.metadata?.location?.end?.line;

  if (startLine === undefined || endLine === undefined) {
    // Fallback if location data is incomplete
    return lines[symbol.line] || null;
  }

  // Adjust for 0-indexed array and 0-indexed row numbers
  const definitionLines = lines.slice(startLine, endLine + 1);
  return definitionLines.join('\n');
};

export const getDefinitionSnippet = async (indexRoot, symbolId, options = {}) => {
  const { contextLines = 3 } = options;
  const resolvedRoot = resolveIndexRoot(indexRoot);
  const symbol = await getSymbolDetailsById(resolvedRoot, symbolId);
  if (!symbol) {
    return null;
  }
  const fileContent = await getFileContent(resolvedRoot, symbol.filePath);
  const lines = fileContent.split('\n');

  const startLine = symbol.metadata?.location?.start?.row;
  const endLine = symbol.metadata?.location?.end?.row;

  if (startLine === undefined || endLine === undefined) {
    return lines[symbol.line] || null;
  }

  const snippetStart = Math.max(0, startLine - contextLines);
  const snippetEnd = Math.min(lines.length - 1, endLine + contextLines);

  const definitionLines = lines.slice(snippetStart, snippetEnd + 1);
  return definitionLines.join('\n');
};

export const getReferences = async (indexRoot, symbolId, options = {}) => {
  const resolvedRoot = resolveIndexRoot(indexRoot);
  const relations = await getRelationsForSymbol(resolvedRoot, symbolId, { ...options, direction: 'target' });
  const referencingSymbols = [];
  for (const relation of relations) {
    const symbol = await getSymbolDetailsById(resolvedRoot, relation.source_symbol_id);
    if (symbol) {
      referencingSymbols.push(symbol);
    }
  }
  return referencingSymbols;
};

export const getSymbolCallers = async (indexRoot, symbolId, options = {}) => {
  const resolvedRoot = resolveIndexRoot(indexRoot);
  const relations = await getRelationsForSymbol(resolvedRoot, symbolId, { ...options, kind: 'calls', direction: 'target' });
  const callers = [];
  for (const relation of relations) {
    const symbol = await getSymbolDetailsById(resolvedRoot, relation.source_symbol_id);
    if (symbol) {
      callers.push(symbol);
    }
  }
  return callers;
};

export const getSymbolCallees = async (indexRoot, symbolId, options = {}) => {
  const resolvedRoot = resolveIndexRoot(indexRoot);
  const relations = await getRelationsForSymbol(resolvedRoot, symbolId, { ...options, kind: 'calls', direction: 'source' });
  const callees = [];
  for (const relation of relations) {
    const symbol = await getSymbolDetailsById(resolvedRoot, relation.target_symbol_id);
    if (symbol) {
      callees.push(symbol);
    }
  }
  return callees;
};

export const getCallGraph = async (indexRoot, symbolId, options = {}) => {
  const resolvedRoot = resolveIndexRoot(indexRoot);
  const { depth = 3, direction = 'both', kind = 'calls' } = options;
  const visited = new Set();
  const graph = { nodes: [], edges: [] };

  const traverse = async (currentSymbolId, currentDepth) => {
    if (currentDepth > depth || visited.has(currentSymbolId)) {
      return;
    }
    visited.add(currentSymbolId);

    const symbolDetails = await getSymbolDetailsById(resolvedRoot, currentSymbolId);
    if (symbolDetails) {
      graph.nodes.push(symbolDetails);
    }

    const relations = await getRelationsForSymbol(resolvedRoot, currentSymbolId, { kind, direction });

    for (const relation of relations) {
      graph.edges.push(relation);
      let nextSymbolId;
      if (direction === 'source' && relation.source_symbol_id !== currentSymbolId) {
        nextSymbolId = relation.source_symbol_id;
      } else if (direction === 'target' && relation.target_symbol_id !== currentSymbolId) {
        nextSymbolId = relation.target_symbol_id;
      } else if (direction === 'both') {
        nextSymbolId = (relation.source_symbol_id === currentSymbolId) ? relation.target_symbol_id : relation.source_symbol_id;
      }

      if (nextSymbolId) {
        await traverse(nextSymbolId, currentDepth + 1);
      }
    }
  };

  await traverse(symbolId, 0);
  return graph;
};
