import { StringDecoder } from 'string_decoder';

/**
 * Bounded stream capture. Agents routinely run commands that emit megabytes
 * (`journalctl`, `dmesg`, `cat` on a big file). Keeping the whole stream would
 * waste memory and blow up the model's context window, so every captured
 * stream is capped and reports whether it was truncated.
 */

/**
 * `headtail` keeps the first half and the last half of the cap. It is the best
 * default for logs: the beginning shows startup errors and headers, the end
 * shows the latest failures, and the model pays for neither the middle nor a
 * full head slice.
 */
export type CaptureMode = 'head' | 'tail' | 'headtail';

export interface CaptureOptions {
  /** Maximum bytes to keep. */
  maxBytes: number;
  /** Keep the beginning (default), the end, or both ends of the stream. */
  mode?: CaptureMode;
}

/** CLI/JSON default. `SSHYA_MAX_OUTPUT` overrides it; MCP passes its own cap. */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;

const NEWLINE_WINDOW_MIN = 32;

/** Search a slice's last `window` bytes for a newline and cut after it. */
const cutAtLastNewline = (buffer: Buffer): Buffer => {
  if (buffer.length === 0 || buffer[buffer.length - 1] === 0x0a) {
    return buffer;
  }

  const window = Math.max(NEWLINE_WINDOW_MIN, Math.floor(buffer.length / 4));
  const floor = Math.max(0, buffer.length - window);
  const index = buffer.lastIndexOf(0x0a, buffer.length - 1);

  return index >= floor ? buffer.subarray(0, index + 1) : buffer;
};

/** Search a slice's first `window` bytes for a newline and start after it. */
const cutAtFirstNewline = (buffer: Buffer): Buffer => {
  if (buffer.length === 0) {
    return buffer;
  }

  const window = Math.max(NEWLINE_WINDOW_MIN, Math.floor(buffer.length / 4));
  const index = buffer.subarray(0, Math.min(buffer.length, window)).indexOf(0x0a);

  return index >= 0 ? buffer.subarray(index + 1) : buffer;
};

/** `1234` -> `1,234`, deterministic across locales. */
const formatCount = (value: number): string =>
  String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const countNewlines = (buffer: Buffer): number => {
  let count = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) {
      count += 1;
    }
  }
  return count;
};

const isContinuationByte = (byte: number): boolean => (byte & 0xc0) === 0x80;

/** Drop an incomplete UTF-8 sequence at the end of a head slice. */
const trimIncompleteTail = (buffer: Buffer): Buffer => {
  let index = buffer.length - 1;
  let continuations = 0;

  while (index >= 0 && isContinuationByte(buffer[index]!) && continuations < 3) {
    index -= 1;
    continuations += 1;
  }

  if (index < 0) {
    return buffer;
  }

  const lead = buffer[index]!;
  const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;

  if (continuations + 1 < expected) {
    return buffer.subarray(0, index);
  }

  return buffer;
};

/** Drop leading continuation bytes after a tail slice. */
const trimIncompleteHead = (buffer: Buffer): Buffer => {
  let index = 0;
  while (index < buffer.length && isContinuationByte(buffer[index]!)) {
    index += 1;
  }
  return index === 0 ? buffer : buffer.subarray(index);
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
};

export const parseByteSize = (value: string): number | undefined => {
  const match = /^(\d+(?:\.\d+)?)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib)?$/i.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const multiplier = unit.startsWith('g')
    ? 1024 * 1024 * 1024
    : unit.startsWith('m')
      ? 1024 * 1024
      : unit.startsWith('k')
        ? 1024
        : 1;

  const bytes = Math.floor(amount * multiplier);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
};

export const defaultMaxOutputBytes = (): number => {
  const raw = process.env.SSHYA_MAX_OUTPUT?.trim();
  if (!raw) {
    return DEFAULT_MAX_OUTPUT_BYTES;
  }
  return parseByteSize(raw) ?? DEFAULT_MAX_OUTPUT_BYTES;
};

export class ByteCapture {
  readonly maxBytes: number;
  readonly mode: CaptureMode;

  private headChunks: Buffer[] = [];
  private headBytes = 0;
  private readonly headLimit: number;

  /** Ring buffer for the tail half (or the whole stream in tail mode). */
  private tailBuffer?: Buffer;
  private readonly tailCapacity: number;
  private tailStart = 0;
  private tailLength = 0;

  totalBytes = 0;
  lineCount = 0;
  truncated = false;

  constructor(options: CaptureOptions) {
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes));
    this.mode = options.mode ?? 'head';

    if (this.mode === 'head') {
      this.headLimit = this.maxBytes;
      this.tailCapacity = 0;
    } else if (this.mode === 'tail') {
      this.headLimit = 0;
      this.tailCapacity = this.maxBytes;
    } else {
      // headtail: ~N/2 head + ~N/2 tail, and exactly N bytes of storage.
      this.headLimit = Math.max(1, Math.floor(this.maxBytes / 2));
      this.tailCapacity = Math.max(0, this.maxBytes - this.headLimit);
    }
  }

  write(chunk: Buffer | string): void {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) {
      return;
    }

    this.totalBytes += buffer.length;
    this.lineCount += countNewlines(buffer);

    let rest = buffer;

    if (this.headLimit > 0 && this.headBytes < this.headLimit) {
      const take = Math.min(this.headLimit - this.headBytes, rest.length);
      this.headChunks.push(rest.subarray(0, take));
      this.headBytes += take;
      rest = rest.subarray(take);
    }

    if (rest.length > 0 && this.tailCapacity > 0) {
      this.writeTail(rest);
    }

    // head+tail storage is exactly `maxBytes`, so exceeding it means bytes
    // were dropped and the output will carry a marker.
    if (this.totalBytes > this.maxBytes) {
      this.truncated = true;
    }
  }

  /** Decoded text, with a marker when truncation happened. */
  text(): string {
    const decoder = new StringDecoder('utf8');

    if (!this.truncated) {
      const whole = this.chunksToBuffer();
      return decoder.write(whole) + decoder.end();
    }

    if (this.mode === 'head') {
      const body = decoder.write(trimIncompleteTail(this.headBuffer())) + decoder.end();
      return body + this.headMarker();
    }

    if (this.mode === 'tail') {
      const body = decoder.write(trimIncompleteHead(this.readTail())) + decoder.end();
      return this.tailMarker() + body;
    }

    // headtail: prefer cutting both slices at newline boundaries so the marker
    // sits on its own line and the reader does not see half a line on either
    // side. Fall back to the raw cut when no newline is near.
    const head = cutAtLastNewline(trimIncompleteTail(this.headBuffer()));
    const tail = cutAtFirstNewline(trimIncompleteHead(this.readTail()));
    const omittedBytes = Math.max(0, this.totalBytes - head.length - tail.length);
    const keptLines = countNewlines(head) + countNewlines(tail);
    const omittedLines = Math.max(0, this.lineCount - keptLines);

    const marker = `\n[... sshya: ${formatCount(omittedLines)} lines / ${formatBytes(omittedBytes)} omitted ...]\n`;

    return decoder.write(head) + marker + decoder.write(tail) + decoder.end();
  }

  private chunksToBuffer(): Buffer {
    const tail = this.readTail();
    if (tail.length === 0) {
      return this.headBuffer();
    }
    if (this.headChunks.length === 0) {
      return tail;
    }
    return Buffer.concat([...this.headChunks, tail], this.headBytes + tail.length);
  }

  private headBuffer(): Buffer {
    if (this.headChunks.length === 0) {
      return Buffer.alloc(0);
    }
    return this.headChunks.length === 1
      ? this.headChunks[0]!
      : Buffer.concat(this.headChunks, this.headBytes);
  }

  private writeTail(buffer: Buffer): void {
    const capacity = this.tailCapacity;
    if (capacity === 0 || buffer.length === 0) {
      return;
    }
    this.tailBuffer ??= Buffer.allocUnsafe(capacity);

    // A single chunk larger than the ring keeps only its last `capacity` bytes.
    if (buffer.length >= capacity) {
      buffer.copy(this.tailBuffer, 0, buffer.length - capacity);
      this.tailStart = 0;
      this.tailLength = capacity;
      return;
    }

    if (this.tailLength + buffer.length > capacity) {
      const overflow = this.tailLength + buffer.length - capacity;
      this.tailStart = (this.tailStart + overflow) % capacity;
      this.tailLength -= overflow;
    }

    let position = (this.tailStart + this.tailLength) % capacity;
    let source = 0;
    while (source < buffer.length) {
      const count = Math.min(buffer.length - source, capacity - position);
      buffer.copy(this.tailBuffer, position, source, source + count);
      position = (position + count) % capacity;
      source += count;
    }
    this.tailLength += buffer.length;
  }

  /** Copy the ring contents out in oldest-first order. */
  private readTail(): Buffer {
    if (this.tailLength === 0 || this.tailCapacity === 0) {
      return Buffer.alloc(0);
    }

    const tail = this.tailBuffer!;
    const result = Buffer.allocUnsafe(this.tailLength);
    const first = Math.min(this.tailLength, this.tailCapacity - this.tailStart);
    tail.copy(result, 0, this.tailStart, this.tailStart + first);

    if (first < this.tailLength) {
      tail.copy(result, first, 0, this.tailLength - first);
    }
    return result;
  }

  private headMarker(): string {
    return `\n… [sshya] truncated: showing first ${formatBytes(this.maxBytes)} of ${formatBytes(this.totalBytes)} …\n`;
  }

  private tailMarker(): string {
    return `… [sshya] truncated: showing last ${formatBytes(this.maxBytes)} of ${formatBytes(this.totalBytes)} …\n`;
  }
}

