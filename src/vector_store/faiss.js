import { OllamaEmbeddings } from "@langchain/ollama";
import { FaissStore } from "@langchain/community/vectorstores/faiss";
import { promises as fs } from 'fs';
import path from 'path';
import { __internals as metadataInternals } from '../indexer/metadata.js';

const FAISS_INDEX_PATH = 'faiss.index';

export const getFaissVectorStore = async () => {
  const embeddings = new OllamaEmbeddings({
    model: process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text:latest",
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  });

  const indexRoot = metadataInternals.resolveIndexRoot(process.cwd());
  const faissIndexPath = path.join(indexRoot, FAISS_INDEX_PATH);

  let vectorStore;

  try {
    // Check if the FAISS index file exists
    await fs.access(faissIndexPath);
    // If it exists, load it
    vectorStore = await FaissStore.load(faissIndexPath, embeddings);
    console.log(`Loaded FAISS index from ${faissIndexPath}`);
  } catch (error) {
    // If it doesn't exist, create a new one (it will be saved later)
    console.log(`FAISS index not found at ${faissIndexPath}. A new one will be created.`);
    vectorStore = new FaissStore(embeddings, {}); // Initialize with empty docs, will add later
  }

  // Override the addDocuments method to save the index after adding documents
  const originalAddDocuments = vectorStore.addDocuments.bind(vectorStore);
  vectorStore.addDocuments = async (documents) => {
    await originalAddDocuments(documents);
    await vectorStore.save(faissIndexPath);
    console.log(`FAISS index saved to ${faissIndexPath}`);
  };

  return vectorStore;
};