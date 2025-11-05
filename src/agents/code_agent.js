import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { CLI_AGENT_PROMPT } from '../prompts/agent_prompts.js';

const DEFAULT_SESSION_ID = 'cli-session';
const CHECKPOINT_NAMESPACE = 'code-agent';
const defaultCheckpointer = new MemorySaver();

const messageContentToText = (message) => {
  if (!message) {
    return '';
  }

  const { content } = message;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part?.text) {
          return part.text;
        }
        if (part?.type === 'tool_call') {
          return '';
        }
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

const ensureHistory = (memoryStore, sessionKey) => {
  if (!memoryStore.has(sessionKey)) {
    memoryStore.set(sessionKey, []);
  }
  return memoryStore.get(sessionKey);
};

const isSystemMessage = (message) => {
  if (!message) {
    return false;
  }
  if (typeof message._getType === 'function') {
    return message._getType() === 'system';
  }
  if (typeof message.getType === 'function') {
    return message.getType() === 'system';
  }
  if (typeof message.role === 'string') {
    return message.role === 'system';
  }
  return false;
};

const buildMessageBatch = (history, input, systemPrompt) => {
  const messages = [];
  const hasSystemMessage = history.some((message) => isSystemMessage(message));

  if (systemPrompt && !hasSystemMessage) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  messages.push({ role: 'user', content: input });

  return messages;
};

/**
 * Builds a LangGraph ReAct agent tailored for the CLI workflow.
 * @param {object} params
 * @param {import('@langchain/core/language_models/chat_models').BaseChatModel} params.llm
 * @param {import('@langchain/core/tools').StructuredToolInterface[]} params.tools
 * @param {string} [params.sessionId]
 * @param {Map<string, any[]>} [params.memoryStore]
 * @param {string} [params.systemPrompt]
 */
export const buildCodeAgent = async ({
  llm,
  tools,
  sessionId = DEFAULT_SESSION_ID,
  memoryStore = new Map(),
  systemPrompt = CLI_AGENT_PROMPT,
  recursionLimit = 150,
  checkpointer = defaultCheckpointer,
}) => {
  const app = createReactAgent({
    llm,
    tools,
    recursionLimit,
    checkpointer,
    checkpointNamespace: CHECKPOINT_NAMESPACE,
    checkpointSaver: defaultCheckpointer,
  });


  const tokenUsage = {
    input: 0,
    output: 0,
  };

  const accumulateUsageMetadata = (metadata) => {
    if (!metadata || typeof metadata !== 'object') {
      return;
    }
    const toNumber = (value) =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;

    const inputTokens =
      toNumber(metadata.input_tokens) ?? toNumber(metadata.prompt_tokens);
    const outputTokens =
      toNumber(metadata.output_tokens) ?? toNumber(metadata.completion_tokens);

    if (inputTokens !== null) {
      tokenUsage.input += inputTokens;
    }
    if (outputTokens !== null) {
      tokenUsage.output += outputTokens;
    }
  };

  const finalizeAgentOutput = (
    agentOutput,
    history,
    historyLength,
    activeSessionId,
  ) => {
    accumulateUsageMetadata(agentOutput?.usage_metadata);
    const messages = Array.isArray(agentOutput?.messages)
      ? agentOutput.messages
      : [];
    memoryStore.set(activeSessionId, messages);

    const finalMessage = messages.at(-1);
    
    const output = messageContentToText(finalMessage);

    accumulateUsageMetadata(finalMessage?.usage_metadata);
    if (Array.isArray(agentOutput?.raw?.messages)) {
      const rawMessages = agentOutput.raw.messages;
      const rawFinal = rawMessages[rawMessages.length - 1];
      if (rawFinal && rawFinal !== finalMessage) {
        accumulateUsageMetadata(rawFinal.usage_metadata);
      }
    }
    const newMessages = messages.slice(historyLength);

    return {
      output,
      messages,
      newMessages,
      eventMessages: newMessages.slice(0, Math.max(0, newMessages.length - 1)),
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

  const invoke = async ({ input, sessionId: activeSessionId = sessionId }) => {
    if (!input) {
      throw new Error('Agent invoke requires a non-empty input.');
    }

    const history = ensureHistory(memoryStore, activeSessionId);
    const historyLength = history.length;
    const requestMessages = buildMessageBatch(history, input, systemPrompt);
    const agentOutput = await app.invoke(
      { messages: requestMessages },
      {
        recursionLimit: Number.isFinite(Number(process.env.AIRA_RECURSION_LIMIT))
          ? Number(process.env.AIRA_RECURSION_LIMIT)
          : 200,
        configurable: {
          thread_id: activeSessionId,
          checkpoint_ns: CHECKPOINT_NAMESPACE,
        },
      },
    );
    return finalizeAgentOutput(agentOutput, history, historyLength, activeSessionId);
  };

  const streamInvoke = async (
    { input, sessionId: activeSessionId = sessionId },
    { onEvent } = {},
  ) => {
    if (!input) {
      throw new Error('Agent invoke requires a non-empty input.');
    }

    const history = ensureHistory(memoryStore, activeSessionId);
    const historyLength = history.length;
    const requestMessages = buildMessageBatch(history, input, systemPrompt);

    const streamModes = ['messages', 'tasks', 'values'];
    const stream = await app.stream(
      { messages: requestMessages },
      {
        recursionLimit: Number.isFinite(Number(process.env.AIRA_RECURSION_LIMIT))
          ? Number(process.env.AIRA_RECURSION_LIMIT)
          : 200,
        configurable: {
          thread_id: activeSessionId,
          checkpoint_ns: CHECKPOINT_NAMESPACE,
        },
        streamMode: streamModes,
      },
    );

    let finalPayload = null;
    const collectedMessages = [];
    const seenMessageIds = new Set();

    const recordMessage = (message) => {
      if (!message || typeof message !== 'object') {
        return;
      }
      const getType =
        typeof message._getType === 'function'
          ? message._getType.bind(message)
          : typeof message.getType === 'function'
            ? message.getType.bind(message)
            : undefined;
      if (getType && getType() === 'ai_chunk') {
        return;
      }
      const identifier =
        typeof message.id === 'string' && message.id
          ? message.id
          : `message-${collectedMessages.length}`;
      if (seenMessageIds.has(identifier)) {
        return;
      }
      seenMessageIds.add(identifier);
      collectedMessages.push(message);
    };

    for await (const chunk of stream) {
      const normalized = normalizeStreamChunk(chunk);
      if (!normalized) {
        continue;
      }

      const { mode, payload } = normalized;

      if (mode === 'messages') {
        const [message] = payload || [];
        recordMessage(message);
      }

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

    const agentOutput =
      finalPayload && typeof finalPayload === 'object' ? finalPayload : {};

    if (!Array.isArray(agentOutput.messages)) {
      const fallbackMessages = [
        ...history,
        ...requestMessages,
        ...collectedMessages,
      ];
      agentOutput.messages = fallbackMessages;
    }

    return finalizeAgentOutput(agentOutput, history, historyLength, activeSessionId);
  };

  return {
    invoke,
    streamInvoke,
    getHistory: (activeSessionId = sessionId) => ensureHistory(memoryStore, activeSessionId),
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
