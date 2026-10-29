import { describe, it, expect } from 'vitest'
import { parseCsv } from './csv'

describe('parseCsv', () => {
  it('parses a simple single row', () => {
    expect(parseCsv('a,b,c', 10)).toEqual([['a', 'b', 'c']])
  })

  it('splits rows on LF and CRLF alike', () => {
    expect(parseCsv('a,b\nc,d', 10)).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseCsv('a,b\r\nc,d', 10)).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('"a,b",c', 10)).toEqual([['a,b', 'c']])
  })

  it('unescapes doubled quotes inside quoted fields', () => {
    expect(parseCsv('"a""b",c', 10)).toEqual([['a"b', 'c']])
  })

  it('keeps newlines inside quoted fields', () => {
    expect(parseCsv('"line1\nline2",c', 10)).toEqual([['line1\nline2', 'c']])
  })

  it('strips a leading UTF-8 BOM', () => {
    expect(parseCsv('﻿a,b', 10)).toEqual([['a', 'b']])
  })

  it('preserves empty trailing fields', () => {
    expect(parseCsv('a,', 10)).toEqual([['a', '']])
  })

  it('keeps blank lines between rows and drops them at the end', () => {
    expect(parseCsv('a\n\nb\n\n\r\n', 10)).toEqual([['a'], [''], ['b']])
  })

  it('returns null past maxRows, counting blank lines between rows but not after them', () => {
    expect(parseCsv('a\nb\n\n\n', 2)).toEqual([['a'], ['b']])
    expect(parseCsv('a\nb\nc', 2)).toBeNull()
    expect(parseCsv('a\n\nb', 2)).toBeNull()
  })
})
