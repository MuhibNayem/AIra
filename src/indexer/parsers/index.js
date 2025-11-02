import * as javascriptParser from './javascript.js';
import * as pythonParser from './python.js';
import * as goParser from './go.js';
import * as javaParser from './java.js';
import { createDiagnostic } from './normalizer.js';

const PARSER_MODULES = [
  javascriptParser,
  pythonParser,
  goParser,
  javaParser,
];

const LANGUAGE_TO_PARSER = new Map();
PARSER_MODULES.forEach((module) => {
  module.SUPPORTED_LANGUAGES.forEach((language) => {
    if (!language) {
      return;
    }
    const key = `${language}`.toLowerCase();
    LANGUAGE_TO_PARSER.set(key, module);
  });
});

export const SUPPORTED_LANGUAGES = new Set(LANGUAGE_TO_PARSER.keys());

export const isLanguageSupported = (language) => {
  if (!language) {
    return false;
  }
  return LANGUAGE_TO_PARSER.has(`${language}`.toLowerCase());
};

export const extractSymbols = async ({ filePath, language }) => {
  const parser = LANGUAGE_TO_PARSER.get(`${language}`.toLowerCase());
  if (!parser) {
    return {
      symbols: [],
      relations: [],
      diagnostics: [
        createDiagnostic({
          severity: 'warning',
          message: `Language "${language}" is not supported for symbol extraction.`,
          location: null,
        }),
      ],
    };
  }

  return parser.extractSymbols({ filePath, language });
};
