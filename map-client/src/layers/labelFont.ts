// The font stack for text drawn by deck.gl, which can't read a CSS variable: the token's value
// (theme/tokens.css --font-text), resolved once, so map labels match the chrome around them.
import { resolveToken } from '../../../theme/tokens';

let stack: string | null = null;

export function labelFont(): string {
  stack ??= resolveToken('--font-text') || 'system-ui, sans-serif';
  return stack;
}
