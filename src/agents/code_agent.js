import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { CLI_AGENT_PROMPT } from '../prompts/agent_prompts.js';
import { create_manage_memory_tool, create_search_memory_tool } from '@langchain/langmem';
import { InMemoryStore } from '@langchain/langgraph-store-memory'; // or PostgresStore if you want persistence

const DEFAULT_SESSION_ID = 'cli-session';
const CHECKPOINT_NAMESPACE = 'code-agent';
const defaultCheckpointer = new MemorySaver();

/**
 * Helper: Extracts message text from LangChain message objects.
 */
const messageContentToText = (message) => {
  if (!message) return '';
  const { content } = message;

  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.text) return part.text;
        if (part?.type === 'tool_call') return '';
        return '';
      })
      .join('')
      .trim();
  }

  if (content && typeof content === 'object' && 'text' in content) {
    return content.text;
  }

  return '';
};

/**
 * Builds a LangGraph ReAct agent tailored for the CLI workflow
 * with persistent memory (tool + user message recall).
 */
export const buildCodeAgent = async ({
  llm,
  tools,
  sessionId = DEFAULT_SESSION_ID,
  systemPrompt = CLI_AGENT_PROMPT,
  recursionLimit = 150,
  checkpointer = defaultCheckpointer,
}) => {
  // 🧠 Set up vector-based memory store
  const store = new InMemoryStore({
    index: {
      dims: 1536, // match your embedding model
      embed: 'openai:text-embedding-3-small', // or another embedding backend
    },
  });

  // 🛠 Add memory tools (store + search)
  const memoryNamespace = ['memories', sessionId];
  const memoryTools = [
    create_manage_memory_tool({ namespace: memoryNamespace, store }),
    create_search_memory_tool({ namespace: memoryNamespace, store }),
  ];

  const combinedTools = [...tools, ...memoryTools];

  // 🚀 Create ReAct agent
  const app = createReactAgent({
    llm,
    tools: combinedTools,
    recursionLimit,
    store, // essential: ensures memory persistence
    checkpointer,
    checkpointNamespace: CHECKPOINT_NAMESPACE,
    checkpointSaver: checkpointer,
  });

  const tokenUsage = { input: 0, output: 0 };

  const accumulateUsageMetadata = (metadata) => {
    if (!metadata || typeof metadata !== 'object') return;
    const toNumber = (v) =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    const input = toNumber(metadata.input_tokens) ?? toNumber(metadata.prompt_tokens);
    const output = toNumber(metadata.output_tokens) ?? toNumber(metadata.completion_tokens);
    if (input !== null) tokenUsage.input += input;
    if (output !== null) tokenUsage.output += output;
  };

  const finalizeAgentOutput = (agentOutput) => {
    accumulateUsageMetadata(agentOutput?.usage_metadata);
    const messages = Array.isArray(agentOutput?.messages)
      ? agentOutput.messages
      : [];
    const finalMessage = messages.at(-1);
    const output = messageContentToText(finalMessage);
    accumulateUsageMetadata(finalMessage?.usage_metadata);

    return {
      output,
      messages,
      raw: agentOutput,
    };
  };

  /**
   * Single-turn invocation
   */
  const invoke = async ({ input }) => {
    if (!input) throw new Error('Agent invoke requires a non-empty input.');
    const agentOutput = await app.invoke(
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: input },
        ],
      },
      {
        recursionLimit,
        configurable: {
          thread_id: sessionId,
          checkpoint_ns: CHECKPOINT_NAMESPACE,
        },
      },
    );

    return finalizeAgentOutput(agentOutput);
  };

  /**
   * Streaming invocation (with memory)
   */
  const streamInvoke = async ({ input }, { onEvent } = {}) => {
    if (!input) throw new Error('Agent invoke requires a non-empty input.');

    const stream = await app.stream(
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: input },
        ],
      },
      {
        recursionLimit,
        configurable: {
          thread_id: sessionId,
          checkpoint_ns: CHECKPOINT_NAMESPACE,
        },
        streamMode: ['messages', 'tasks', 'values'],
      },
    );

    let finalPayload = null;

    for await (const chunk of stream) {
      if (typeof onEvent === 'function') await onEvent(chunk);
      if (Array.isArray(chunk) && chunk[1] === 'values') {
        finalPayload = chunk[2];
      }
    }

    return finalizeAgentOutput(finalPayload || {});
  };

  return {
    invoke,
    streamInvoke,
    sessionId,
    app,
    recursionLimit,
    getTokenUsage: () => ({
      input: tokenUsage.input,
      output: tokenUsage.output,
      total: tokenUsage.input + tokenUsage.output,
    }),
  };
};
