import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, parseMarkdown, plainText } from '../src/lib/chatMarkdown.ts';

test('bold spans', () => {
  assert.deepEqual(parseInline('**Mugar** is **busy** now'), [
    { text: 'Mugar', bold: true },
    { text: ' is ', bold: false },
    { text: 'busy', bold: true },
    { text: ' now', bold: false },
  ]);
  assert.deepEqual(parseInline('2 ** 3 is not bold'), [{ text: '2 ** 3 is not bold', bold: false }]);
  assert.deepEqual(parseInline('****'), [{ text: '****', bold: false }]);
});

test('paragraphs and bullet lists', () => {
  const blocks = parseMarkdown('First line\nsame paragraph.\n\n- **One**\n- Two\n  continued\n\nLast.');
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], { kind: 'paragraph', spans: [{ text: 'First line same paragraph.', bold: false }] });
  assert.equal(blocks[1].kind, 'list');
  if (blocks[1].kind === 'list') {
    assert.equal(blocks[1].items.length, 2);
    assert.deepEqual(blocks[1].items[0], [{ text: 'One', bold: true }]);
    assert.deepEqual(blocks[1].items[1], [{ text: 'Two continued', bold: false }]);
  }
  assert.deepEqual(blocks[2], { kind: 'paragraph', spans: [{ text: 'Last.', bold: false }] });
});

test('a list right after a paragraph line starts a list', () => {
  const blocks = parseMarkdown('Options:\n- A\n- B\r\nAfter');
  assert.deepEqual(blocks.map((b) => b.kind), ['paragraph', 'list', 'paragraph']);
});

test('HTML stays text: nothing but paragraphs, lists and bold comes out', () => {
  const src = '<script>alert(1)</script> **<img src=x onerror=alert(1)>**\n\n- <a href="javascript:x">link</a>\n\n# Heading [x](javascript:y)';
  const blocks = parseMarkdown(src);
  assert.ok(blocks.every((b) => b.kind === 'paragraph' || b.kind === 'list'));
  const first = blocks[0];
  assert.ok(first.kind === 'paragraph');
  assert.deepEqual(first.spans, [
    { text: '<script>alert(1)</script> ', bold: false },
    { text: '<img src=x onerror=alert(1)>', bold: true },
  ]);
  assert.ok(blocks[1].kind === 'list' && blocks[1].items[0][0].text === '<a href="javascript:x">link</a>');
  assert.ok(blocks[2].kind === 'paragraph' && blocks[2].spans[0].text === '# Heading [x](javascript:y)');
  // Every span is a plain string with only `text` and `bold`; the renderer makes text nodes from them.
  for (const b of blocks) {
    for (const spans of b.kind === 'paragraph' ? [b.spans] : b.items) {
      for (const s of spans) assert.deepEqual(Object.keys(s).sort(), ['bold', 'text']);
    }
  }
});

test('plain text for announcements', () => {
  assert.equal(plainText('**Mugar** is busy.\n\n- SEL quiet\n- GSU open'), 'Mugar is busy. SEL quiet. GSU open');
});
