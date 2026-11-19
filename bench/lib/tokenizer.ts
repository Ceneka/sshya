/**
 * Token counting for bench measurements.
 *
 * Primary: gpt-tokenizer (o200k_base, the GPT-4o family encoding). This is a
 * real BPE tokenizer, not an estimate. cl100k_base is reported alongside where
 * it differs materially. `chars/4` is always reported so numbers can be
 * compared with the rule of thumb used elsewhere.
 */
import { encode as encodeO200k } from 'gpt-tokenizer/encoding/o200k_base';
import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base';

export const TOKENIZER_NAME = 'gpt-tokenizer 3.x o200k_base (cl100k_base for reference)';

let o200kCache = new Map<string, number>();
let cl100kCache = new Map<string, number>();

const count = (cache: Map<string, number>, encode: (text: string) => number[], text: string): number => {
  const cached = cache.get(text);
  if (cached !== undefined) {
    return cached;
  }
  const value = encode(text).length;
  if (cache.size > 20_000) {
    cache.clear();
  }
  cache.set(text, value);
  return value;
};

/** Tokens in the o200k_base encoding (default reported number). */
export const tokens = (text: string): number => count(o200kCache, encodeO200k, text);

/** Tokens in the cl100k_base encoding (older GPT-4/3.5 encoding). */
export const tokensCl100k = (text: string): number => count(cl100kCache, encodeCl100k, text);

export const chars = (text: string): number => text.length;

export const approxTokens = (text: string): number => Math.ceil(text.length / 4);

export interface Size {
  chars: number;
  tokens: number;
  tokensCl100k: number;
  approxTokens: number;
}

export const sizeOf = (text: string): Size => ({
  chars: text.length,
  tokens: tokens(text),
  tokensCl100k: tokensCl100k(text),
  approxTokens: approxTokens(text),
});

export const fmt = (n: number): string => n.toLocaleString('en-US');

/** One-line size summary used in console tables. */
export const sizeCell = (text: string): string => {
  const size = sizeOf(text);
  return `${fmt(size.chars)} ch / ${fmt(size.tokens)} tok`;
};

export const pct = (part: number, whole: number): string => {
  if (whole === 0) return '0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
};

export { encodeO200k };
