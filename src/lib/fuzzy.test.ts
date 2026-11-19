import { describe, expect, test } from "bun:test";
import Fuse from "fuse.js";
import { fuzzySearch } from "./fuzzy";

/**
 * Parity tests: these import the real fuse.js v7 and assert that the local
 * port returns the same items in the same order for the configuration sshya
 * uses (`keys: ['name']`, `threshold: 0.4`, all other options default).
 */

const fuseSearch = (
    names: readonly string[],
    term: string,
    threshold = 0.4,
): string[] => {
    const fuse = new Fuse(names.map(name => ({ name })), { keys: ["name"], threshold });
    return fuse.search(term).map(result => result.item.name);
};

const portSearch = (
    names: readonly string[],
    term: string,
    threshold = 0.4,
): string[] =>
    fuzzySearch(names, term, name => name, { threshold });

const assertParity = (
    names: readonly string[],
    term: string,
    threshold = 0.4,
): void => {
    const expected = fuseSearch(names, term, threshold);
    const actual = portSearch(names, term, threshold);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        throw new Error(
            `Parity failure (term=${JSON.stringify(term)}, threshold=${threshold})\n` +
            `  names:    ${JSON.stringify(names)}\n` +
            `  fuse.js:  ${JSON.stringify(expected)}\n` +
            `  fuzzy.ts: ${JSON.stringify(actual)}`,
        );
    }
};

const SSH_ALIASES = [
    "prod-db-1",
    "prod-db-2",
    "prod-web-1",
    "prod-web-2",
    "staging-db",
    "staging-web",
    "bastion",
    "kafka-broker-03",
    "kafka-broker-04",
    "my_server.example.com",
    "my_server.internal.example.com",
    "jumpbox",
    "build-runner-01",
    "build-runner-02",
    "metrics-grafana",
    "logs-es-01",
    "backup-nas",
    "office-pi",
    "web",
    "db",
];

const LONG_ALIASES = [
    "prod-cluster-eu-west-1-database-primary-01",
    "prod-cluster-eu-west-1-database-replica-02",
    "staging-cluster-us-east-2-application-server-01",
    "bastion-node-for-the-development-environment-001",
    "averyveryverylongaliaswithoutanyseparatorsatall",
    "prod-eu-west-1-kafka-broker-cluster-node-0003",
];

const UNICODE_ALIASES = [
    "café-server",
    "cafe-server",
    "Ünïcödé-servér",
    "unicode-server",
    "münchen-db",
    "munchen-db",
    "straße-web",
    "strasse-web",
    "日本語サーバー",
    "emoji-🚀-host",
    "İstanbul-node",
    "istanbul-node",
];

describe("sshya alias parity", () => {
    test("realistic alias set with typo, prefix and substring queries", () => {
        const terms = [
            "prod db 1",
            "prod-db",
            "prod db",
            "proddb1",
            "prod-db-01",
            "prod-web",
            "prod-wbe",
            "staging",
            "stagin-web",
            "stagingweb",
            "bastion",
            "bastio",
            "basiton",
            "kafka",
            "kafka-broker",
            "kafka brokr 03",
            "broker-03",
            "my_server",
            "my server",
            "example.com",
            "internal.example",
            "jump",
            "jumpbox",
            "build-runner-002",
            "build runner",
            "grafana",
            "metrics-grafan",
            "logs-es",
            "es-01",
            "backup",
            "nas",
            "pi",
            "web",
            "db",
            "1",
            "0",
            "-",
            ".com",
        ];
        for (const term of terms) assertParity(SSH_ALIASES, term);
    });

    test("empty and whitespace-only terms return everything in order", () => {
        for (const term of ["", " ", "   ", "\t", "\n", " \t\n "]) {
            const expected = SSH_ALIASES.slice();
            expect(portSearch(SSH_ALIASES, term)).toEqual(expected);
            assertParity(SSH_ALIASES, term);
        }
    });

    test("terms longer than 32 characters are split into chunks", () => {
        const terms = [
            "prod-cluster-eu-west-1-database-primary-01",
            "prod-cluster-eu-west-1-database-primary",
            "prod-cluster-eu-west-1-database",
            "cluster-eu-west-1-database-primary-01",
            "a".repeat(33),
            "a".repeat(40),
            "a".repeat(47) + "-tail",
            "database-primary-01".repeat(3),
            "the-development-environment-001",
            "x".repeat(64),
            "x".repeat(65),
            "prod".repeat(20),
        ];
        for (const term of terms) assertParity(LONG_ALIASES, term);
        for (const term of terms) assertParity(SSH_ALIASES, term);
    });

    test("long item names are matched by short and long terms", () => {
        for (const term of ["prod", "cluster", "primary", "replica", "server-01", "node"]) {
            assertParity(LONG_ALIASES, term);
        }
    });

    test("case differences are ignored like Fuse defaults", () => {
        const terms = [
            "PROD-DB-1",
            "Prod-Db",
            "KAFKA",
            "Kafka Broker 03",
            "BASTION",
            "My_Server.Example.COM",
            "mY_sErVeR",
            "WEB",
            "Db",
        ];
        for (const term of terms) assertParity(SSH_ALIASES, term);
    });

    test("unicode and accents are compared without diacritic folding", () => {
        const terms = [
            "café",
            "cafe",
            "CAFÉ",
            "CAFE",
            "münchen",
            "munchen",
            "straße",
            "strasse",
            "ünïcödé",
            "unicode",
            "日本語",
            "サーバー",
            "emoji",
            "🚀",
            "İstanbul",
            "istanbul",
            "İ",
            "i",
        ];
        for (const term of terms) assertParity(UNICODE_ALIASES, term);
    });

    test("blank key values are skipped except for blank queries", () => {
        const names = ["", "   ", "prod-db", "prod", "\t"];
        assertParity(names, "");
        assertParity(names, "   ");
        assertParity(names, "prod");
        assertParity(names, "db");
        assertParity(names, "zzz");
    });

    test("only matches above the threshold are returned", () => {
        for (const threshold of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1]) {
            for (const term of ["prod", "prod-db", "proddb1", "staging-web", "bastion", "zzz", "xyz"]) {
                assertParity(SSH_ALIASES, term, threshold);
            }
        }
    });

    test("result ordering matches Fuse for equal scores", () => {
        const names = Array.from({ length: 30 }, (_, i) => `host-${i % 3}`);
        for (const term of ["host", "host-1", "host-0", "h"]) assertParity(names, term);
    });
});

describe("fuzzySearch API", () => {
    test("returns the original item references in Fuse order", () => {
        const items = SSH_ALIASES.map(name => ({ name }));
        const expected = fuseSearch(SSH_ALIASES, "prod db");
        const actual = fuzzySearch(items, "prod db", item => item.name);
        expect(actual.map(item => item.name)).toEqual(expected);
        for (const item of actual) {
            expect(items).toContain(item);
        }
    });

    test("default threshold is 0.4", () => {
        expect(fuzzySearch(SSH_ALIASES, "prod db", name => name)).toEqual(
            portSearch(SSH_ALIASES, "prod db", 0.4),
        );
    });

    test("does not mutate its input", () => {
        const items = SSH_ALIASES.slice();
        fuzzySearch(items, "prod", name => name);
        expect(items).toEqual(SSH_ALIASES);
    });
});

describe("randomized parity", () => {
    const mulberry32 = (seed: number): (() => number) => {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    };

    const pick = <T,>(rand: () => number, values: readonly T[]): T =>
        values[Math.floor(rand() * values.length)]!;

    const randomString = (
        rand: () => number,
        minLength: number,
        maxLength: number,
        charset: string,
    ): string => {
        const length = minLength + Math.floor(rand() * (maxLength - minLength + 1));
        let out = "";
        for (let i = 0; i < length; i += 1) {
            out += charset[Math.floor(rand() * charset.length)]!;
        }
        return out;
    };

    const ITEM_CHARSET = "abcxyzABCXYZ0123456789._-";
    const QUERY_CHARSET = "abcxyzABCXYZ0123456789._- /éüñ";

    test("seeded random item sets and queries match Fuse exactly", () => {
        const rand = mulberry32(0x5eed_2026);
        const mismatches: string[] = [];
        const iterations = 3000;

        for (let iteration = 0; iteration < iterations; iteration += 1) {
            const nameCount = Math.floor(rand() * 13);
            const names: string[] = [];
            for (let i = 0; i < nameCount; i += 1) {
                const style = rand();
                if (style < 0.55) {
                    const prefix = pick(rand, ["prod", "staging", "dev", "kafka", "web", "db", "host"]);
                    names.push(`${prefix}-${randomString(rand, 0, 42, ITEM_CHARSET)}`);
                } else if (style < 0.85) {
                    names.push(randomString(rand, 0, 46, ITEM_CHARSET));
                } else {
                    names.push(randomString(rand, 0, 55, "éüñßØabcXYZ0123456789 -_"));
                }
            }

            const term = rand() < 0.08
                ? pick(rand, ["", " ", "   ", "\t", " \n "])
                : randomString(rand, 1, 70, QUERY_CHARSET);
            const threshold = pick(rand, [0, 0.1, 0.2, 0.4, 0.5, 0.6, 1]);

            const expected = fuseSearch(names, term, threshold);
            const actual = portSearch(names, term, threshold);
            if (JSON.stringify(expected) !== JSON.stringify(actual)) {
                mismatches.push(
                    `iteration=${iteration} term=${JSON.stringify(term)} threshold=${threshold}\n` +
                    `  names:    ${JSON.stringify(names)}\n` +
                    `  fuse.js:  ${JSON.stringify(expected)}\n` +
                    `  fuzzy.ts: ${JSON.stringify(actual)}`,
                );
                if (mismatches.length >= 3) break;
            }
        }

        expect(mismatches).toEqual([]);
    });

    test("seeded random queries over realistic aliases match Fuse exactly", () => {
        const rand = mulberry32(0xc0ffee);
        const pool = [...SSH_ALIASES, ...LONG_ALIASES, ...UNICODE_ALIASES];
        const mismatches: string[] = [];

        for (let iteration = 0; iteration < 1500; iteration += 1) {
            const names: string[] = [];
            const nameCount = Math.floor(rand() * 9);
            for (let i = 0; i < nameCount; i += 1) names.push(pick(rand, pool));

            // Mutate the query a little so it lands near real aliases.
            const source = pick(rand, pool);
            const mutation = rand();
            let term: string;
            if (mutation < 0.4) {
                term = source.slice(0, Math.floor(rand() * (source.length + 1)));
            } else if (mutation < 0.7) {
                const start = Math.floor(rand() * source.length);
                term = source.slice(start, start + 1 + Math.floor(rand() * 42));
            } else {
                term = source;
            }
            if (rand() < 0.5) term = term.toUpperCase();
            if (rand() < 0.3) term = `  ${term} `;

            const expected = fuseSearch(names, term);
            const actual = portSearch(names, term);
            if (JSON.stringify(expected) !== JSON.stringify(actual)) {
                mismatches.push(
                    `iteration=${iteration} term=${JSON.stringify(term)}\n` +
                    `  names:    ${JSON.stringify(names)}\n` +
                    `  fuse.js:  ${JSON.stringify(expected)}\n` +
                    `  fuzzy.ts: ${JSON.stringify(actual)}`,
                );
                if (mismatches.length >= 3) break;
            }
        }

        expect(mismatches).toEqual([]);
    });
});
