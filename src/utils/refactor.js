const CODE_BLOCK_REGEX = /Updated Code:\s*```(?:[a-zA-Z0-9+\-._]*)?\n([\s\S]*?)```/i;
const GENERIC_CODE_BLOCK_REGEX = /```(?:[a-zA-Z0-9+\-._]*)?\n([\s\S]*?)```/;

/**
 * Extracts the updated code content from the refactor chain response.
 * @param {string} response
 * @returns {{ code: string, explanation?: string }}
 */
export const extractUpdatedCode = (response) => {
  if (!response || typeof response !== 'string') {
    throw new Error('Refactor response is empty or not a string.');
  }

  const primaryMatch = CODE_BLOCK_REGEX.exec(response);
  if (primaryMatch && primaryMatch[1]) {
    return { code: primaryMatch[1].trimEnd() };
  }

  const fallbackMatch = GENERIC_CODE_BLOCK_REGEX.exec(response);
  if (fallbackMatch && fallbackMatch[1]) {
    return { code: fallbackMatch[1].trimEnd() };
  }

  throw new Error('Failed to parse updated code block from refactor response.');
};
