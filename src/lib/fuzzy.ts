/**
 * Zero-dependency fuzzy search, ported from Fuse.js v7 (Apache-2.0).
 *
 * Fuse is only used by sshya for `new Fuse(choices, { keys: ['name'],
 * threshold: 0.4 })` followed by `fuse.search(term).map(r => r.item)`. Every
 * other option keeps its default: case-insensitive Bitap, no diacritic
 * folding, location 0, distance 100, field-length norm with weight 1, 32-char
 * pattern chunks, stable sort by score then index. This module implements
 * exactly that path so the dependency can be removed.
 */

export interface FuzzySearchOptions {
    /** Fuse's `threshold`: 0 requires a perfect match, 1 matches anything. */
    threshold?: number;
}

const LOCATION = 0;
const DISTANCE = 100;
const MIN_MATCH_CHAR_LENGTH = 1;
const MAX_PATTERN_LENGTH = 32;
const FIELD_NORM_WEIGHT = 1;
const FIELD_NORM_MANTISSA = 3;

interface BitapResult {
    isMatch: boolean;
    score: number;
}

interface PatternChunk { pattern: string; alphabet: Record<string, number>; startIndex: number }

const isWordSeparator = (code: number): boolean =>
    (code >= 9 && code <= 13) || code === 32 || code === 160;

/**
 * Fuse's field-length norm: short fields score better. Token counts are
 * rounded to `mantissa` digits and memoized.
 */
const createFieldNorm = () => {
    const cache = new Map<number, number>();
    const m = Math.pow(10, FIELD_NORM_MANTISSA);

    return (value: string): number => {
        let numTokens = 0;
        let inWord = false;
        for (let i = 0; i < value.length; i += 1) {
            if (!isWordSeparator(value.charCodeAt(i))) {
                if (!inWord) {
                    numTokens += 1;
                    inWord = true;
                }
            } else {
                inWord = false;
            }
        }
        if (numTokens === 0) numTokens = 1;

        const cached = cache.get(numTokens);
        if (cached !== undefined) return cached;
        const n = Math.round(m / Math.pow(numTokens, 0.5 * FIELD_NORM_WEIGHT)) / m;
        cache.set(numTokens, n);
        return n;
    };
};

/** Bitmask of the positions where each pattern character occurs. */
const createPatternAlphabet = (pattern: string): Record<string, number> => {
    const mask: Record<string, number> = {};
    for (let i = 0, len = pattern.length; i < len; i += 1) {
        const char = pattern.charAt(i);
        mask[char] = (mask[char] ?? 0) | (1 << (len - i - 1));
    }
    return mask;
};

/**
 * Fuse's Bitap search (`src/search/bitap/search.ts`) without match-highlight
 * bookkeeping, which this configuration never enables.
 */
const bitapSearch = (
    text: string,
    pattern: string,
    patternAlphabet: Record<string, number>,
    location: number,
    threshold: number,
): BitapResult => {
    const patternLen = pattern.length;
    const textLen = text.length;
    const expectedLocation = Math.max(0, Math.min(location, textLen));
    let currentThreshold = threshold;
    let bestLocation = expectedLocation;

    const calcScore = (errors: number, currentLocation: number): number =>
        errors / patternLen + Math.abs(expectedLocation - currentLocation) / DISTANCE;

    // Exact occurrences tighten the threshold before the Bitap pass.
    let index: number;
    while ((index = text.indexOf(pattern, bestLocation)) > -1) {
        currentThreshold = Math.min(calcScore(0, index), currentThreshold);
        bestLocation = index + patternLen;
    }

    bestLocation = -1;
    let lastBitArr: number[] = [];
    let finalScore = 1;
    let binMax = patternLen + textLen;
    const mask = 1 << (patternLen - 1);

    for (let i = 0; i < patternLen; i += 1) {
        let binMin = 0;
        let binMid = binMax;
        while (binMin < binMid) {
            if (calcScore(i, expectedLocation + binMid) <= currentThreshold) binMin = binMid;
            else binMax = binMid;
            binMid = Math.floor((binMax - binMin) / 2 + binMin);
        }
        binMax = binMid;

        let start = Math.max(1, expectedLocation - binMid + 1);
        const finish = Math.min(expectedLocation + binMid, textLen) + patternLen;
        const bitArr: number[] = new Array(finish + 2);
        bitArr[finish + 1] = (1 << i) - 1;

        for (let j = finish; j >= start; j -= 1) {
            const currentLocation = j - 1;
            const charMatch = patternAlphabet[text[currentLocation] as string] ?? 0;
            let bits = ((bitArr[j + 1]! << 1) | 1) & charMatch;
            if (i) bits |= ((lastBitArr[j + 1]! | lastBitArr[j]!) << 1) | 1 | lastBitArr[j + 1]!;
            bitArr[j] = bits;

            if (bits & mask) {
                finalScore = calcScore(i, currentLocation);
                if (finalScore <= currentThreshold) {
                    currentThreshold = finalScore;
                    bestLocation = currentLocation;
                    if (bestLocation <= expectedLocation) break;
                    start = Math.max(1, 2 * expectedLocation - bestLocation);
                }
            }
        }

        if (calcScore(i + 1, expectedLocation) > currentThreshold) break;
        lastBitArr = bitArr;
    }

    return { isMatch: bestLocation >= 0, score: Math.max(0.001, finalScore) };
};

/**
 * Split a pattern into the overlapping 32-character chunks Fuse uses.
 */
const createChunks = (pattern: string): PatternChunk[] => {
    const chunks: PatternChunk[] = [];
    if (!pattern.length) return chunks;

    const addChunk = (chunkPattern: string, startIndex: number) => {
        chunks.push({ pattern: chunkPattern, alphabet: createPatternAlphabet(chunkPattern), startIndex });
    };

    const len = pattern.length;
    if (len > MAX_PATTERN_LENGTH) {
        let i = 0;
        const remainder = len % MAX_PATTERN_LENGTH;
        const end = len - remainder;
        while (i < end) {
            addChunk(pattern.slice(i, i + MAX_PATTERN_LENGTH), i);
            i += MAX_PATTERN_LENGTH;
        }
        if (remainder) {
            const startIndex = len - MAX_PATTERN_LENGTH;
            addChunk(pattern.slice(startIndex), startIndex);
        }
    } else {
        addChunk(pattern, 0);
    }
    return chunks;
};

/** Fuse's `BitapSearch.searchIn`: chunk scores are averaged, not minimized. */
const searchInChunks = (
    text: string,
    pattern: string,
    chunks: readonly PatternChunk[],
    threshold: number,
): BitapResult => {
    if (pattern === text) {
        if (text.length < MIN_MATCH_CHAR_LENGTH) return { isMatch: false, score: 1 };
        return { isMatch: true, score: 0 };
    }

    let totalScore = 0;
    let hasMatches = false;
    for (const chunk of chunks) {
        const result = bitapSearch(
            text,
            chunk.pattern,
            chunk.alphabet,
            LOCATION + chunk.startIndex,
            threshold,
        );
        if (result.isMatch) hasMatches = true;
        totalScore += result.score;
    }

    return { isMatch: hasMatches, score: hasMatches ? totalScore / chunks.length : 1 };
};

/**
 * Return the items whose key matches `term`, ordered like Fuse 7 with
 * `{ keys: ['name'], threshold }` and every other option at its default.
 */
export const fuzzySearch = <T>(
    items: readonly T[],
    term: string,
    getKey: (item: T) => string,
    options: FuzzySearchOptions = {},
): T[] => {
    const threshold = options.threshold ?? 0.4;

    // Fuse returns every doc, in insertion order, for an empty/blank query.
    if (!term.trim()) return items.slice();

    const pattern = term.toLowerCase();
    const chunks = createChunks(pattern);
    const fieldNorm = createFieldNorm();
    const results: Array<{ item: T; idx: number; score: number }> = [];

    for (let idx = 0; idx < items.length; idx += 1) {
        const item = items[idx]!;
        const key = getKey(item);
        if (!key.trim()) continue; // Fuse drops missing and whitespace-only keys.

        const norm = fieldNorm(key);
        const { isMatch, score } = searchInChunks(key.toLowerCase(), pattern, chunks, threshold);
        if (!isMatch) continue;

        // computeScoreSingle with a single key of weight 1. An exact full-string
        // match has score 0, which Fuse clamps to EPSILON before weighting.
        const weighted = Math.pow(score === 0 ? Number.EPSILON : score, norm);
        results.push({ item, idx, score: weighted });
    }

    // Fuse's default sortFn: score ascending, then original index ascending.
    results.sort((a, b) =>
        a.score === b.score ? (a.idx < b.idx ? -1 : 1) : a.score < b.score ? -1 : 1,
    );

    return results.map(result => result.item);
};
