import { ChatOllama } from '@langchain/ollama';

export const ollama = new ChatOllama({
  baseURL: process.env.OLLAMA_BASE_URL,
  model: process.env.OLLAMA_MODEL,
  // format: 'json',
  temperature: 0.2,
  streaming: true,
  keepAlive: 480,
});