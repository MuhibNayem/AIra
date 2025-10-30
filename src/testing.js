// Import the function from your other file
import { createWebSearchTool } from "./tools/web_search.js";

// This is an "async IIFE" (Immediately Invoked Function Expression)
// It's just a simple way to use 'await' at the top level.
(async () => {
  console.log("Creating the web search tool...");

  // 1. Create an instance of the tool
  const searchTool = createWebSearchTool();

  // 2. Define a query
  const query = "What's the latest news on Qwen3?";

  console.log(`Running tool with query: "${query}"`);

  // 3. Call the tool's .func() method with your query
  try {
 await searchTool.func(query);

    // 4. Print the results
    console.log("\n--- Search Results ---");
  } catch (error) {
    console.error("An error occurred:", error);
  }
})();
