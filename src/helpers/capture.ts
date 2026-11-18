import { StringDecoder } from 'string_decoder';

/**
 * Bounded stream capture. Agents routinely run commands that emit megabytes
 * (`journalctl`, `dmesg`, `cat` on a big file). Keeping the whole stream would
 * waste memory and blow up the model's context window, so every captured
 * stream is capped and reports whether it was truncated.
 */

export type CaptureMode = 'head' | 'tail';

export interface CaptureOptions {
  /** Maximum bytes to keep. */
  maxBytes: number;
  /** Keep the beginning (default) or the end of the stream. */
  mode?: CaptureMode;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

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

  private chunks: Buffer[] = [];
  private storedBytes = 0;

  totalBytes = 0;
  lineCount = 0;
  truncated = false;

  constructor(options: CaptureOptions) {
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes));
    this.mode = options.mode ?? 'head';
  }

  write(chunk: Buffer | string): void {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) {
      return;
    }

    this.totalBytes += buffer.length;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] === 0x0a) {
        this.lineCount += 1;
      }
    }

    if (this.mode === 'head') {
      if (this.storedBytes >= this.maxBytes) {
        this.truncated = true;
        return;
      }

      const room = this.maxBytes - this.storedBytes;
      if (buffer.length > room) {
        this.chunks.push(buffer.subarray(0, room));
        this.storedBytes += room;
        this.truncated = true;
      } else {
        this.chunks.push(buffer);
        this.storedBytes += buffer.length;
      }
      return;
    }

    // Tail mode: keep a sliding window of the last `maxBytes`.
    this.chunks.push(buffer);
    this.storedBytes += buffer.length;

    while (this.storedBytes > this.maxBytes && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      const excess = this.storedBytes - this.maxBytes;
      this.truncated = true;

      if (first.length <= excess) {
        this.chunks.shift();
        this.storedBytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.storedBytes -= excess;
      }
    }
  }

  /** Decoded text, with a marker when truncation happened. */
  text(): string {
    let buffer = this.chunks.length === 0
      ? Buffer.alloc(0)
      : this.chunks.length === 1
        ? this.chunks[0]!
        : Buffer.concat(this.chunks);

    if (this.truncated) {
      buffer = this.mode === 'head' ? trimIncompleteTail(buffer) : trimIncompleteHead(buffer);
    }

    // StringDecoder avoids splitting a multi-byte code point that landed on a
    // chunk boundary. It only matters for the bytes we kept.
    const decoder = new StringDecoder('utf8');
    const body = decoder.write(buffer) + decoder.end();

    if (!this.truncated) {
      return body;
    }

    const marker = this.mode === 'head'
      ? `\n… [sshya] truncated: showing first ${formatBytes(this.maxBytes)} of ${formatBytes(this.totalBytes)} …\n`
      : `… [sshya] truncated: showing last ${formatBytes(this.maxBytes)} of ${formatBytes(this.totalBytes)} …\n`;

    return this.mode === 'head' ? body + marker : marker + body;
  }
}
