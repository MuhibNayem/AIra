import { promises as fs } from 'fs';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { getSymbolsInFile, getDefinition } from '../indexer/symbols.js';
import { logger } from '../utils/logger.js';

export const getDocumentsForFile = async (filePath) => {
  const documents = [];
  logger.debug(`Processing file: ${filePath}`);
  const symbols = await getSymbolsInFile(process.cwd(), filePath);
  logger.debug(`  getSymbolsInFile returned ${symbols.length} symbols for ${filePath}`);

  for (const symbol of symbols) {
    try {
      logger.debug(`    Getting definition for symbol: ${symbol.name} (ID: ${symbol.id}) in ${filePath}`);
      const definition = await getDefinition(process.cwd(), symbol.id);
      if (definition) {
        logger.debug(`      Definition found for ${symbol.name}. Length: ${definition.length}`);
        const splitter = new RecursiveCharacterTextSplitter({
          chunkSize: 1000, // Adjust chunk size as needed
          chunkOverlap: 200, // Adjust chunk overlap as needed
        });
        const symbolDocs = await splitter.createDocuments([definition], {
          filePath: filePath,
          symbolName: symbol.name,
          symbolKind: symbol.kind,
          // Add other relevant symbol metadata here
        });
        documents.push(...symbolDocs);
      } else {
        logger.debug(`      No definition found for ${symbol.name}.`);
      }
    } catch (error) {
      logger.warn(`Failed to get definition for symbol ${symbol.name} in ${filePath}: ${error.message}`);
    }
  }
  return documents;
};