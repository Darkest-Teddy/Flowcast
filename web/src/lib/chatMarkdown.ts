// The small markdown subset chat answers use (chatContract.ts): paragraphs, **bold** and "- "
// bullet lists, nothing else. Parsed into plain data that React renders as text nodes, so nothing
// in an answer can become HTML: "<script>" stays the eight characters it is. No imports.

export interface Span {
  text: string;
  bold: boolean;
}

export type Block = { kind: 'paragraph'; spans: Span[] } | { kind: 'list'; items: Span[][] };

/** "**a** b" to [{a, bold}, {" b"}]. An unmatched "**" is kept as literal text. */
export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  const push = (t: string, bold: boolean) => {
    if (!t) return;
    const last = spans[spans.length - 1];
    if (last && last.bold === bold) last.text += t;
    else spans.push({ text: t, bold });
  };
  let rest = text;
  while (rest) {
    const open = rest.indexOf('**');
    if (open === -1) break;
    const close = rest.indexOf('**', open + 2);
    if (close === -1) break;
    const inner = rest.slice(open + 2, close);
    if (!inner.trim()) {
      // "****" or "** **": not bold, keep the characters.
      push(rest.slice(0, close + 2), false);
      rest = rest.slice(close + 2);
      continue;
    }
    push(rest.slice(0, open), false);
    push(inner, true);
    rest = rest.slice(close + 2);
  }
  push(rest, false);
  return spans;
}

const BULLET = /^\s*[-*•]\s+(.*)$/;

/**
 * Blank lines separate paragraphs; consecutive "- " lines form one list; other single line breaks
 * inside a paragraph become spaces. Headings, links and the rest aren't part of the subset and
 * show as the plain text they are.
 */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', spans: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };
  const flushList = () => {
    if (list?.length) blocks.push({ kind: 'list', items: list.map(parseInline) });
    list = null;
  };

  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const bullet = BULLET.exec(raw);
    if (!line) {
      flushParagraph();
      flushList();
    } else if (bullet && bullet[1].trim()) {
      flushParagraph();
      (list ??= []).push(bullet[1].trim());
    } else if (list && /^\s{2,}/.test(raw)) {
      // An indented continuation of the last bullet.
      list[list.length - 1] += ` ${line}`;
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

/** The answer without markup, e.g. for a screen-reader announcement. */
export function plainText(source: string): string {
  return parseMarkdown(source)
    .map((b) => (b.kind === 'paragraph' ? b.spans.map((s) => s.text).join('') : b.items.map((i) => i.map((s) => s.text).join('')).join('. ')))
    .join(' ');
}
