import "dotenv/config";
import { Ollama } from "ollama";
import { DynamicTool } from "@langchain/core/tools";

const ollama = new Ollama();

export const createWebSearchTool = () => {
  return new DynamicTool({
    name: "web_search",
    description:
      "Searches the web for a given query using Ollama's built-in search. Returns a JSON string of search results.",
    func: async (input) => {
      try {
        const res = await ollama.webSearch({
          query: input,
          maxResults: 10,
        });
        return JSON.stringify(res.results);
      } catch (error) {
        return `Error performing web search: ${error.message}`;
      }
    },
  });
};
