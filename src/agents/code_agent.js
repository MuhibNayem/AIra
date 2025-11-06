import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { CLI_AGENT_PROMPT } from '../prompts/agent_prompts.js';
import { InMemoryStore } from '@langchain/langgraph';
import { buildTooling } from '../build_tools.js';

const DEFAULT_SESSION_ID = 'cli-session';
const CHECKPOINT_NAMESPACE = 'code-agent';
const defaultCheckpointer = new MemorySaver();

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

export const buildCodeAgent = async ({
  ollama,
  sessionId = DEFAULT_SESSION_ID,
  systemPrompt = CLI_AGENT_PROMPT,
  systemInfo,
  refactorChain,
  recursionLimit = 150,
  checkpointer = defaultCheckpointer,
}) => {
  const store = new InMemoryStore({
    index: {
      dims: 1536,
      embed: process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text:latest',
    },
  });

  const { tools } = buildTooling(refactorChain, systemInfo, store);
  const llm = ollama.bindTools(tools);

  const loadMemoryContext = async (input, limit = 1) => {
    try {
      const results = await store.search(['tool_memory'], { query: input, limit });
      if (!results.length) return '';
      return results
        .map(
          (m) =>
            `Tool: ${m.value.tool}\nTime: ${m.value.timestamp}\nInput: ${JSON.stringify(
              m.value.input,
            )}\nOutput:\n${m.value.output}`,
        )
        .join('\n\n');
    } catch (err) {
      console.warn('[Memory] Failed to load past tool memories:', err);
      return '';
    }
  };

  const app = createReactAgent({
    llm,
    tools,
    recursionLimit,
    store,
    checkpointer,
    checkpointNamespace: CHECKPOINT_NAMESPACE,
    checkpointSaver: checkpointer,
  });

  const tokenUsage = { input: 0, output: 0 };

  const accumulateUsageMetadata = (metadata) => {
    if (!metadata || typeof metadata !== 'object') return;
    const toNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const input = toNumber(metadata.input_tokens) ?? toNumber(metadata.prompt_tokens);
    const output = toNumber(metadata.output_tokens) ?? toNumber(metadata.completion_tokens);
    if (input !== null) tokenUsage.input += input;
    if (output !== null) tokenUsage.output += output;
  };

  const finalizeAgentOutput = (agentOutput) => {
    accumulateUsageMetadata(agentOutput?.usage_metadata);
    const messages = Array.isArray(agentOutput?.messages) ? agentOutput.messages : [];
    const finalMessage = messages.at(-1);
    const output = messageContentToText(finalMessage);
    accumulateUsageMetadata(finalMessage?.usage_metadata);
    return {
      output,
      messages,
      raw: agentOutput,
    };
  };

  const normalizeStreamChunk = (chunk) => {
    if (!Array.isArray(chunk)) {
      return undefined;
    }

    if (chunk.length === 2 && typeof chunk[0] === 'string') {
      return {
        mode: chunk[0],
        payload: chunk[1],
      };
    }

    if (
      chunk.length === 3 &&
      Array.isArray(chunk[0]) &&
      typeof chunk[1] === 'string'
    ) {
      return {
        namespace: chunk[0],
        mode: chunk[1],
        payload: chunk[2],
      };
    }

    return undefined;
  };

  // -------------------------------------------------------------------
  // 🔁 HELPER: Load last checkpoint to decide whether to re-send system prompt
  // -------------------------------------------------------------------
  const hasExistingCheckpoint = async () => {
    try {
      const checkpoint = await app.getState({
        configurable: {
          thread_id: sessionId,
        },
      });
      return Object.keys(checkpoint.values).length != 0;
    } catch {
      return false;
    }
  };

  // -------------------------------------------------------------------
  // INVOKE
  // -------------------------------------------------------------------
  const invoke = async ({ input }) => {
    if (!input) throw new Error('Agent invoke requires a non-empty input.');

    const memoryContext = await loadMemoryContext(input);
    const hasCheckpoint = await hasExistingCheckpoint();

    // ✅ Include system prompt only on first turn
    const messages = [];
    if (!hasCheckpoint) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push({
      role: 'system',
      content: `Relevant past tool results:\n${memoryContext}`,
    });
    messages.push({ role: 'user', content: input });

    const agentOutput = await app.invoke(
      { messages },
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

  // -------------------------------------------------------------------
  // STREAM INVOKE
  // -------------------------------------------------------------------
  const streamInvoke = async ({ input }, { onEvent } = {}) => {
    if (!input) throw new Error('Agent invoke requires a non-empty input.');

    // const memoryContext = await loadMemoryContext(input);
    const hasCheckpoint = await hasExistingCheckpoint();

    // ✅ Include system prompt only on first turn
    const messages = [];
    if (!hasCheckpoint) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // messages.push({
    //   role: 'system',
    //   content: `Relevant past tool results:\n${memoryContext}`,
    // });
    messages.push({ role: 'user', content: input });

    const stream = await app.stream(
      { messages },
      {
        recursionLimit,
        configurable: {
          thread_id: sessionId,
          checkpoint_ns: CHECKPOINT_NAMESPACE,
        },
        streamMode: ['messages', 'tasks', 'values'],
      },
    );

    let finalPayload = null

    for await (const chunk of stream) {
      const normalized = normalizeStreamChunk(chunk);
      if (!normalized) {
        continue;
      }
      const { mode, payload } = normalized;
      if (mode === 'values') {
        finalPayload = payload;
      }
      if (typeof onEvent === 'function') {
        await onEvent({
          mode,
          payload,
        });
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
