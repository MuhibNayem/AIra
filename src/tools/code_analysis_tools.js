import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  getSymbolCallers,
  getSymbolCallees,
  getReferences,
  getCallGraph,
} from "../indexer/symbols.js";

export const createCodeAnalysisTools = (indexRoot) => {
  const getCallersTool = tool(
    async ({ symbolName }) => {
      const results = await getSymbolCallers(indexRoot, symbolName);
      return JSON.stringify(results);
    },
    {
      name: "getCallers",
      description:
        "Finds all the functions that call a given function. Input should be a JSON string: { \"symbolName\": \"<function name>\" }.",
      schema: z.object({
        symbolName: z.string().min(1, "symbolName is required"),
      }),
    }
  );

  const getCalleesTool = tool(
    async ({ symbolName }) => {
      const results = await getSymbolCallees(indexRoot, symbolName);
      return JSON.stringify(results);
    },
    {
      name: "getCallees",
      description:
        "Finds all the functions that are called by a given function. Input should be a JSON string: { \"symbolName\": \"<function name>\" }.",
      schema: z.object({
        symbolName: z.string().min(1, "symbolName is required"),
      }),
    }
  );

  const getReferencesTool = tool(
    async ({ symbolName }) => {
      const results = await getReferences(indexRoot, symbolName);
      return JSON.stringify(results);
    },
    {
      name: "getReferences",
      description:
        "Finds all the places where a symbol (e.g., a variable, a class) is used. Input should be a JSON string: { \"symbolName\": \"<symbol name>\" }.",
      schema: z.object({
        symbolName: z.string().min(1, "symbolName is required"),
      }),
    }
  );

  const buildCallGraphTool = tool(
    async ({ symbolName }) => {
      const results = await getCallGraph(indexRoot, symbolName);
      return JSON.stringify(results);
    },
    {
      name: "buildCallGraph",
      description:
        "Builds a call graph for a given function, showing the chain of function calls. Input should be a JSON string: { \"symbolName\": \"<function name>\" }.",
      schema: z.object({
        symbolName: z.string().min(1, "symbolName is required"),
      }),
    }
  );

  return [getCallersTool, getCalleesTool, getReferencesTool, buildCallGraphTool];
};
