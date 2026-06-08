import { describe, it, expect } from 'vitest';
import { isSafeRelativePath, safeHttpUrl } from './redirect';

describe('isSafeRelativePath', () => {
	it('accepts a normal same-origin path', () => {
		expect(isSafeRelativePath('/prospects')).toBe(true);
		expect(isSafeRelativePath('/projects/abc?status=new')).toBe(true);
	});

	it('rejects protocol-relative and backslash-smuggled targets', () => {
		expect(isSafeRelativePath('//evil.com')).toBe(false);
		expect(isSafeRelativePath('/\\evil.com')).toBe(false);
	});

	it('rejects absolute URLs and non-leading-slash values', () => {
		expect(isSafeRelativePath('https://evil.com')).toBe(false);
		expect(isSafeRelativePath('http://evil.com')).toBe(false);
		expect(isSafeRelativePath('evil.com')).toBe(false);
		expect(isSafeRelativePath('')).toBe(false);
	});

	it('rejects tab/CR/LF-laced values that the URL parser would strip to //evil', () => {
		expect(isSafeRelativePath('/\t/evil.com')).toBe(false);
		expect(isSafeRelativePath('/\r/evil.com')).toBe(false);
		expect(isSafeRelativePath('/\n/evil.com')).toBe(false);
	});
});

describe('safeHttpUrl', () => {
	it('returns the URL unchanged for http and https', () => {
		expect(safeHttpUrl('https://example.com')).toBe('https://example.com');
		expect(safeHttpUrl('http://example.com/x?y=1')).toBe('http://example.com/x?y=1');
	});

	it('returns null for dangerous or non-web schemes', () => {
		expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
		expect(safeHttpUrl('data:text/html,<script>')).toBeNull();
		expect(safeHttpUrl('file:///etc/passwd')).toBeNull();
	});

	it('returns null for empty, nullish, or unparseable values', () => {
		expect(safeHttpUrl(null)).toBeNull();
		expect(safeHttpUrl(undefined)).toBeNull();
		expect(safeHttpUrl('')).toBeNull();
		expect(safeHttpUrl('not a url')).toBeNull();
		expect(safeHttpUrl('/relative/path')).toBeNull();
	});
});
