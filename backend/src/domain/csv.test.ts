import { describe, it, expect } from 'vitest'
import { parseCsv } from './csv'

describe('parseCsv', () => {
  it('parses a simple single row', () => {
    expect(parseCsv('a,b,c')).toEqual([['a', 'b', 'c']])
  })

  it('splits rows on LF and CRLF alike', () => {
    expect(parseCsv('a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseCsv('a,b\r\nc,d')).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('"a,b",c')).toEqual([['a,b', 'c']])
  })

  it('unescapes doubled quotes inside quoted fields', () => {
    expect(parseCsv('"a""b",c')).toEqual([['a"b', 'c']])
  })

  it('keeps newlines inside quoted fields', () => {
    expect(parseCsv('"line1\nline2",c')).toEqual([['line1\nline2', 'c']])
  })

  it('strips a leading UTF-8 BOM', () => {
    expect(parseCsv('﻿a,b')).toEqual([['a', 'b']])
  })

  it('preserves empty trailing fields', () => {
    expect(parseCsv('a,')).toEqual([['a', '']])
  })
})
