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

  test('keeps the first and last halves in headtail mode', () => {
    const capture = new ByteCapture({ maxBytes: 10, mode: 'headtail' });
    capture.write('abcdefghijklmnopqrstuvwxyz');

    expect(capture.totalBytes).toBe(26);
    expect(capture.truncated).toBe(true);
    const text = capture.text();
    expect(text.startsWith('abcde')).toBe(true);
    expect(text.endsWith('vwxyz')).toBe(true);
    expect(text).toContain('[... sshya: 0 lines / 16 B omitted ...]');
  });

  test('reports omitted lines and bytes in the headtail marker', () => {
    const capture = new ByteCapture({ maxBytes: 40, mode: 'headtail' });
    capture.write(Array.from({ length: 16 }, (_, index) => `line-${String(index).padStart(2, '0')}`).join('\n') + '\n');

    const text = capture.text();
    expect(text).toContain('[... sshya: 12 lines / 96 B omitted ...]');
  });

  test('prefers newline boundaries on both cuts in headtail mode', () => {
    const capture = new ByteCapture({ maxBytes: 40, mode: 'headtail' });
    capture.write(Array.from({ length: 16 }, (_, index) => `line-${String(index).padStart(2, '0')}`).join('\n') + '\n');

    const body = capture.text().split('\n').filter(line => line.length > 0);
    const contentLines = body.filter(line => !line.startsWith('[... sshya:'));

    expect(contentLines.length).toBe(4);
    for (const line of contentLines) {
      expect(line).toMatch(/^line-\d{2}$/);
    }
    expect(contentLines[0]).toBe('line-00');
    expect(contentLines[1]).toBe('line-01');
    expect(contentLines[2]).toBe('line-14');
    expect(contentLines[3]).toBe('line-15');
  });

  test('never splits a multibyte code point at either headtail cut', () => {
    const capture = new ByteCapture({ maxBytes: 8, mode: 'headtail' });
    capture.write('€'.repeat(10));

    const text = capture.text();
    expect(text).not.toContain('\uFFFD');
    expect(text.startsWith('€')).toBe(true);
    expect(text.endsWith('€')).toBe(true);
    expect(text).toContain('[... sshya: 0 lines / 24 B omitted ...]');
  });

  test('does not truncate a headtail stream that fits exactly', () => {
    const capture = new ByteCapture({ maxBytes: 16, mode: 'headtail' });
    capture.write('x'.repeat(16));

    expect(capture.truncated).toBe(false);
    expect(capture.text()).toBe('x'.repeat(16));
    expect(capture.text()).not.toContain('sshya');
  });

  test('reassembles a fitting headtail stream split across writes and the two buffers', () => {
    const capture = new ByteCapture({ maxBytes: 10, mode: 'headtail' });
    capture.write('abcd');
    capture.write('efghij');

    expect(capture.truncated).toBe(false);
    expect(capture.text()).toBe('abcdefghij');
  });

  test('does not split a code point that straddles the head/tail boundary when nothing is omitted', () => {
    const capture = new ByteCapture({ maxBytes: 10, mode: 'headtail' });
    capture.write('a€€€');

    expect(capture.truncated).toBe(false);
    expect(capture.text()).toBe('a€€€');
  });

  test('formats large omitted line counts with thousands separators', () => {
    const capture = new ByteCapture({ maxBytes: 64, mode: 'headtail' });
    capture.write(Array.from({ length: 2000 }, (_, index) => `line ${index}`).join('\n') + '\n');

    expect(capture.text()).toMatch(/\[\.\.\. sshya: 1,\d{3} lines \//);
  });

  test('keeps headtail memory bounded to the cap', () => {
    const capture = new ByteCapture({ maxBytes: 64, mode: 'headtail' });
    for (let index = 0; index < 1000; index += 1) {
      capture.write('x'.repeat(100));
    }

    const internals = capture as unknown as { headChunks: Buffer[]; tailBuffer?: Buffer };
    const retained = internals.headChunks.reduce((total, chunk) => total + chunk.length, 0)
      + (internals.tailBuffer?.length ?? 0);

    expect(retained).toBeLessThanOrEqual(64);
    expect(capture.text()).toContain('[... sshya:');
  });

  test('handles a single huge line in headtail mode', () => {
    const capture = new ByteCapture({ maxBytes: 20, mode: 'headtail' });
    capture.write('x'.repeat(500));

    const text = capture.text();
    expect(text.startsWith('x'.repeat(10))).toBe(true);
    expect(text.endsWith('x'.repeat(10))).toBe(true);
    expect(text.match(/x/g)?.length).toBe(20);
    expect(text).toContain('0 lines / 480 B omitted');
  });

  test('handles tiny headtail caps without broken UTF-8', () => {
    for (const maxBytes of [1, 2, 3, 5]) {
      const capture = new ByteCapture({ maxBytes, mode: 'headtail' });
      capture.write('é€\n'.repeat(3));

      const text = capture.text();
      expect(text).not.toContain('\uFFFD');
      expect(capture.truncated).toBe(true);
      expect(text).toContain('sshya');
    }
  });
});
