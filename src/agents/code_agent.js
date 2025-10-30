import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { GEMINI_CLI_AGENT_PROMPT } from '../prompts/agent_prompts.js';

const DEFAULT_SESSION_ID = 'cli-session';

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
  const retainedHistory = history.filter((message) => !isSystemMessage(message));
  const messages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...retainedHistory]
    : [...retainedHistory];

  return [...messages, { role: 'user', content: input }];
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
  systemPrompt = GEMINI_CLI_AGENT_PROMPT,
  recursionLimit = 150,
}) => {
  const app = createReactAgent({
    llm,
    tools,
    recursionLimit,
  });

  const invoke = async ({ input, sessionId: activeSessionId = sessionId }) => {
    if (!input) {
      throw new Error('Agent invoke requires a non-empty input.');
    }

    const history = ensureHistory(memoryStore, activeSessionId);
    const historyLength = history.length;
    const requestMessages = buildMessageBatch(history, input, systemPrompt);
    const agentOutput = await app.invoke({ messages: requestMessages }, {
      recursionLimit: Number.isFinite(Number(process.env.AIRA_RECURSION_LIMIT))
        ? Number(process.env.AIRA_RECURSION_LIMIT)
        : 200,
    });
    const { messages = [] } = agentOutput;

    memoryStore.set(activeSessionId, messages);

    const finalMessage = messages.at(-1);
    const output = messageContentToText(finalMessage);
    const newMessages = messages.slice(historyLength);

    return {
      output,
      messages,
      newMessages,
      eventMessages: newMessages.slice(0, Math.max(0, newMessages.length - 1)),
      raw: agentOutput,
    };
  };

  return {
    invoke,
    getHistory: (activeSessionId = sessionId) => ensureHistory(memoryStore, activeSessionId),
    sessionId,
    app,
    recursionLimit,
  };
};
