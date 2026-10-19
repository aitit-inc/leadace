import { describe, expect, it } from 'vitest';
import { typedWebsite } from './website';

describe('typedWebsite', () => {
  it('adds https to a bare domain', () => {
    expect(typedWebsite(' acme.com ')).toBe('https://acme.com');
  });

  it('keeps a full URL with its path', () => {
    expect(typedWebsite('http://acme.com/pricing')).toBe('http://acme.com/pricing');
  });

  it('drops what is not a website', () => {
    expect(typedWebsite('')).toBeNull();
    expect(typedWebsite('localhost')).toBeNull();
    expect(typedWebsite('javascript:alert(1)')).toBeNull();
    expect(typedWebsite('https://user:pw@acme.com')).toBeNull();
    expect(typedWebsite(`acme.com/${'a'.repeat(200)}`)).toBeNull();
  });
});
