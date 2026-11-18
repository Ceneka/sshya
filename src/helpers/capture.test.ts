import { describe, expect, test } from 'bun:test';
import { ByteCapture } from './capture';

describe('ByteCapture', () => {
  test('keeps the head and reports truncation', () => {
    const capture = new ByteCapture({ maxBytes: 10 });
    capture.write('a'.repeat(25));

    expect(capture.totalBytes).toBe(25);
    expect(capture.truncated).toBe(true);
    const text = capture.text();
    expect(text.startsWith('aaaaaaaaaa')).toBe(true);
    expect(text).toContain('truncated: showing first 10 B');
  });

  test('keeps the tail when asked', () => {
    const capture = new ByteCapture({ maxBytes: 5, mode: 'tail' });
    capture.write('hello world');

    expect(capture.truncated).toBe(true);
    expect(capture.text()).toContain('world');
    expect(capture.text()).toContain('showing last 5 B of 11 B');
  });

  test('does not truncate when the stream fits exactly', () => {
    const capture = new ByteCapture({ maxBytes: 5 });
    capture.write('abcde');

    expect(capture.totalBytes).toBe(5);
    expect(capture.truncated).toBe(false);
    expect(capture.text()).toBe('abcde');
  });

  test('counts lines across the full stream', () => {
    const capture = new ByteCapture({ maxBytes: 4 });
    capture.write('a\nb\nc\nd\ne\n');

    expect(capture.lineCount).toBe(5);
    expect(capture.truncated).toBe(true);
  });

  test('never returns a broken UTF-8 code point at the cut', () => {
    // 'á' is two bytes; a one-byte cap would slice it in half.
    const capture = new ByteCapture({ maxBytes: 1 });
    capture.write('á');

    expect(capture.text()).not.toContain('\uFFFD');
  });

  test('handles repeated writes without losing the tail', () => {
    const capture = new ByteCapture({ maxBytes: 4, mode: 'tail' });
    capture.write('ab');
    capture.write('cd');
    capture.write('ef');

    expect(capture.text()).toContain('cdef');
    expect(capture.text()).not.toContain('abcd');
  });
});
