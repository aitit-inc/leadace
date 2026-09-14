import { describe, expect, it } from 'vitest';
import { formatDollars, parseDollars } from './credits';

const amount = { min: 1000, max: 50_000 };
const threshold = { min: 100, max: 10_000 };

describe('parseDollars', () => {
	it('accepts whole dollars inside the range', () => {
		expect(parseDollars('17', amount, 100)).toEqual({ cents: 1700, error: null });
		expect(parseDollars(' 500 ', amount, 100)).toEqual({ cents: 50_000, error: null });
	});

	it('rejects the range edges, cents on a whole-dollar field, and non-numbers', () => {
		expect(parseDollars('9.99', amount, 100).error).toMatch('between $10 and $500');
		expect(parseDollars('501', amount, 100).error).toMatch('between $10 and $500');
		expect(parseDollars('10.50', amount, 100).error).toBe('Whole dollars only.');
		expect(parseDollars('', amount, 100).error).toBe('Enter an amount.');
		expect(parseDollars('ten', amount, 100).error).toBe('Enter an amount like 12 or 12.50.');
	});

	it('checks the text before rounding, so a third decimal or a numeric form never slips through', () => {
		expect(parseDollars('10.001', amount, 100).error).toBe('Enter an amount like 12 or 12.50.');
		expect(parseDollars('9.999', amount, 100).error).toBe('Enter an amount like 12 or 12.50.');
		expect(parseDollars('1e2', amount, 100).error).toBe('Enter an amount like 12 or 12.50.');
		expect(parseDollars('$10', amount, 100).error).toBe('Enter an amount like 12 or 12.50.');
		expect(parseDollars('12,50', threshold, 1).error).toBe('Enter an amount like 12 or 12.50.');
		expect(parseDollars('10.00', amount, 100)).toEqual({ cents: 1000, error: null });
	});

	it('lets a threshold carry cents', () => {
		expect(parseDollars('2.5', threshold, 1)).toEqual({ cents: 250, error: null });
		expect(parseDollars('0.99', threshold, 1).error).toMatch('between $1 and $100');
	});
});

describe('formatDollars', () => {
	it('drops the cents only when whole', () => {
		expect(formatDollars(1000)).toBe('$10');
		expect(formatDollars(250)).toBe('$2.50');
	});
});
