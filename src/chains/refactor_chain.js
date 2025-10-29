import { ChatPromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';

const REFRACTOR_SYSTEM_PROMPT = `
You are AIra, an expert software engineer.
You receive an existing code block and a goal for how it should change.
Provide the updated code and a concise explanation of the key changes.
Focus on safe, incremental improvements that preserve functionality unless told otherwise.
Return your answer as:

---
Explanation:
<bullet points>

Updated Code:
\`\`\`
<code>
\`\`\`
---
`;

/**
 * Creates a lightweight refactoring chain to support agent tooling.
 * @param {import('@langchain/core/language_models/chat_models').BaseChatModel} llm
 */
export const createRefactorChain = (llm) => {
  const prompt = ChatPromptTemplate.fromMessages([
    ['system', REFRACTOR_SYSTEM_PROMPT],
    [
      'human',
      `Code to refactor:\n\`\`\`\n{code}\n\`\`\`\n\nGoal:\n{instructions}\n\nAdditional context:\n{context}`,
    ],
  ]);

  return RunnableSequence.from([prompt, llm, new StringOutputParser()]);
};
