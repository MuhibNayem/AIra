import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const createVectorStoreSearchTool = (vectorStore) => {
  return tool(
    async ({ query, k = 4 }) => {
      const results = await vectorStore.similaritySearch(query, k);
      return JSON.stringify(results.map(doc => ({ pageContent: doc.pageContent, metadata: doc.metadata })));
    },
    {
      name: "searchVectorStore",
      description:
        "Searches the Chroma vector store for documents similar to the query. Input should be a JSON string: { \"query\": \"<query string>\", \"k\"?: <number of results> }.",
      schema: z.object({
        query: z.string().min(1, "query is required"),
        k: z.number().int().positive().optional(),
      }),
    }
  );
};
