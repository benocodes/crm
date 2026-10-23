import { describe, expect, it } from 'vitest'
import { CodecError, codecs } from './index.js'

describe('timestamps', () => {
  it('reads a Date or a string as the same public ISO text', () => {
    expect(codecs.timestamp.read(new Date('2026-10-22T09:00:00.123Z'))).toBe('2026-10-22T09:00:00.123Z')
    expect(codecs.timestamp.read('2026-10-22T09:00:00.123Z')).toBe('2026-10-22T09:00:00.123Z')
    expect(codecs.timestamp.read('2026-10-22T11:00:00.000+02:00')).toBe('2026-10-22T09:00:00.000Z')
    expect(codecs.timestamp.read('2026-10-22 09:00:00+00')).toBe('2026-10-22T09:00:00.000Z')
  })
  it('keeps null and rejects malformed values', () => {
    expect(codecs.timestamp.readNullable(null)).toBeNull()
    expect(() => codecs.timestamp.read('not a time')).toThrow(CodecError)
    expect(() => codecs.timestamp.read(12)).toThrow(CodecError)
    expect(() => codecs.timestamp.read(new Date('nope'))).toThrow(CodecError)
  })
  it('writes ISO text with milliseconds in UTC, from a Date or an offset string', () => {
    expect(codecs.timestamp.write(new Date('2026-10-22T09:00:00Z'))).toBe('2026-10-22T09:00:00.000Z')
    expect(codecs.timestamp.write('2026-10-25T10:00:00+02:00')).toBe('2026-10-25T08:00:00.000Z')
    expect(() => codecs.timestamp.write('2026-10-25')).toThrow(CodecError)
  })
})

describe('json', () => {
  it('reads an object or its text and does not double-decode', () => {
    expect(codecs.json.read({ a: 1 })).toEqual({ a: 1 })
    expect(codecs.json.read('{"a":1}')).toEqual({ a: 1 })
    expect(codecs.json.read('"{\\"a\\":1}"')).toBe('{"a":1}')
    expect(codecs.json.readNullable(null)).toBeNull()
  })
  it('writes text once', () => {
    expect(codecs.json.write({ a: 1 })).toBe('{"a":1}')
    expect(codecs.json.write(null)).toBeNull()
  })
  it('rejects malformed text', () => {
    expect(() => codecs.json.read('{nope')).toThrow(CodecError)
  })
})

describe('booleans and arrays', () => {
  it('reads true booleans and 0/1', () => {
    expect([codecs.boolean.read(true), codecs.boolean.read(false), codecs.boolean.read(1), codecs.boolean.read(0)]).toEqual([true, false, true, false])
    expect(() => codecs.boolean.read(2)).toThrow(CodecError)
    expect(() => codecs.boolean.read('yes')).toThrow(CodecError)
  })
  it('writes integers for D1 and keeps booleans for Postgres', () => {
    expect(codecs.boolean.write(true, 'd1')).toBe(1)
    expect(codecs.boolean.write(false, 'd1')).toBe(0)
    expect(codecs.boolean.write(true, 'postgres')).toBe(true)
  })
  it('reads an array or its JSON text, rejecting non-string members', () => {
    expect(codecs.stringArray.read(['a', 'b'])).toEqual(['a', 'b'])
    expect(codecs.stringArray.read('["a","b"]')).toEqual(['a', 'b'])
    expect(() => codecs.stringArray.read([1])).toThrow(CodecError)
    expect(() => codecs.stringArray.read('{}')).toThrow(CodecError)
  })
  it('writes arrays natively on Postgres and as JSON text on D1', () => {
    expect(codecs.stringArray.write(['a'], 'postgres')).toEqual(['a'])
    expect(codecs.stringArray.write(['a'], 'd1')).toBe('["a"]')
  })
})

describe('nullables', () => {
  it('reads null as null for every codec', () => {
    expect(codecs.boolean.readNullable(null)).toBeNull()
    expect(codecs.stringArray.readNullable(null)).toBeNull()
    expect(codecs.timestamp.readNullable(undefined)).toBeNull()
  })
})
