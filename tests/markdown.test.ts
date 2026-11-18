import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/web/markdown.js';

test('renders review messages as Markdown and keeps single line breaks', () => {
  const html = renderMarkdown('First line\nSecond **bold** and `code`\n\n- one\n- two\n\n```js\nconst x = 1;\n```');
  assert.match(html, /First line<br\s*\/?>\s*Second/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<pre><code class="language-js">const x = 1;/);
});

test('does not execute HTML or turn script URLs into links or images', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1))\n\n![image](javascript:alert(1))');
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /<a\b/i);
  assert.match(html, /&lt;img/);
});
