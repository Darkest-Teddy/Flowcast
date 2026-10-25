import type { AgentMessage } from './askClient';

export const MAX_HISTORY_PAIRS = 6;
export const MAX_USER_LENGTH = 300;
export const MAX_ASSISTANT_LENGTH = 4000;
export const MAX_HISTORY_LENGTH = MAX_HISTORY_PAIRS * (MAX_USER_LENGTH + MAX_ASSISTANT_LENGTH);

function truncate(content: string, limit: number): string {
  const text = content.slice(0, limit);
  // Avoid cutting a supplementary Unicode character between its surrogate halves.
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
}

export function appendExchange(history: readonly AgentMessage[], question: string, answer: string): AgentMessage[] {
  const pairs: AgentMessage[][] = [];
  for (let i = 0; i + 1 < history.length; i++) {
    if (history[i].role === 'user' && history[i + 1].role === 'assistant') {
      pairs.push([history[i], history[i + 1]]);
      i++;
    }
  }
  pairs.push([{ role: 'user', content: question }, { role: 'assistant', content: answer }]);
  return pairs.slice(-MAX_HISTORY_PAIRS).flat().map(({ role, content }) => ({
    role,
    content: truncate(content, role === 'user' ? MAX_USER_LENGTH : MAX_ASSISTANT_LENGTH),
  }));
}
