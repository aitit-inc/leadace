import { describe, it, expect } from 'vitest';
import { renderChatMarkdown } from './chat-markdown';

describe('renderChatMarkdown', () => {
	it('renders a GFM table', () => {
		const html = renderChatMarkdown('| A | B |\n| :--- | :--- |\n| 1 | 2 |');
		expect(html).toContain('<table>');
		expect(html).toContain('>A</th>');
		expect(html).toContain('>1</td>');
	});

	it('renders inline code', () => {
		expect(renderChatMarkdown('a `b@c.com` d')).toContain('<code>b@c.com</code>');
	});

	it('drops raw HTML tags, leaving the text between them as text', () => {
		const html = renderChatMarkdown('before <script>alert(1)</script> after');
		expect(html).not.toContain('<script');
		expect(html).not.toContain('</script');
		expect(html).toContain('before alert(1) after');
	});

	it('drops an inline HTML tag', () => {
		expect(renderChatMarkdown('a<br>b')).not.toContain('<br>');
	});

	it('drops a markdown image', () => {
		const html = renderChatMarkdown('![x](https://example.com/pixel.png?d=secret)');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('pixel.png');
	});

	it('drops an image even inside a link', () => {
		expect(renderChatMarkdown('[![x](https://example.com/p.png)](https://example.com)')).not.toContain('p.png');
	});

	it('opens a link in a new tab with no referrer or opener', () => {
		const html = renderChatMarkdown('[site](https://example.com/a)');
		expect(html).toContain('href="https://example.com/a"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
	});

	it('keeps a javascript: link as text', () => {
		const html = renderChatMarkdown('[click](javascript:alert(1))');
		expect(html).not.toContain('<a ');
		expect(html).toContain('click');
	});

	it('keeps a data: link as text', () => {
		expect(renderChatMarkdown('[x](data:text/html,<script>alert(1)</script>)')).not.toContain('<a ');
	});

	it('escapes markup inside a script wrapper', () => {
		const html = renderChatMarkdown('x <script>a<img:x onclick=alert(1)>b</script> y');
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;img:x');
	});

	it('escapes markup inside a code wrapper', () => {
		const html = renderChatMarkdown('x <code>a<img src="//evil.example/b?x=1" -bogus>b</code> y');
		expect(html).not.toContain('<img');
	});

	it('escapes markup inside a kbd wrapper', () => {
		const html = renderChatMarkdown('x <kbd>a<img src=//evil.example/k onerror=alert(1) -z>b</kbd> y');
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;img');
	});

	it('allows a mailto link', () => {
		expect(renderChatMarkdown('[mail](mailto:a@b.com)')).toContain('href="mailto:a@b.com"');
	});

	it('escapes text that looks like markup', () => {
		expect(renderChatMarkdown('5 < 6 & 7 > 2')).toContain('&lt;');
	});

	it('answers empty for empty input', () => {
		expect(renderChatMarkdown('')).toBe('');
	});
});
