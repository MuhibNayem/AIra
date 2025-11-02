import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScriptPkg from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Go from 'tree-sitter-go';
import Java from 'tree-sitter-java';

const { typescript: TypeScript, tsx: TSX } = TypeScriptPkg.default ?? TypeScriptPkg;

const LANGUAGE_REGISTRY = new Map([
  ['javascript', JavaScript],
  ['jsx', JavaScript],
  ['typescript', TypeScript],
  ['tsx', TSX],
  ['python', Python],
  ['py', Python],
  ['go', Go],
  ['golang', Go],
  ['java', Java],
]);

const normalizeLanguageKey = (language) => {
  if (!language) {
    return null;
  }
  const key = `${language}`.toLowerCase();
  return LANGUAGE_REGISTRY.has(key) ? key : null;
};

export const parseWithTreeSitter = ({ language, source }) => {
  const key = normalizeLanguageKey(language);
  if (!key || typeof source !== 'string') {
    return null;
  }
  const lang = LANGUAGE_REGISTRY.get(key);
  if (!lang) {
    return null;
  }
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser.parse(source);
};

export const nodeToRange = (node) => ({
  start: {
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
  },
  end: {
    line: node.endPosition.row + 1,
    column: node.endPosition.column + 1,
  },
});

export const sliceText = (source, node) =>
  source.slice(node.startIndex, node.endIndex);

export const supportedTreeSitterLanguages = () => Array.from(new Set(
  Array.from(LANGUAGE_REGISTRY.keys()).map((key) => {
    switch (key) {
      case 'py':
        return 'python';
      case 'golang':
        return 'go';
      default:
        return key;
    }
  }),
));
