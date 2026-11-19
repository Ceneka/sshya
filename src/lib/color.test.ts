import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk, { Chalk } from 'chalk';
import color, { createColor } from './color';

type StyleName = 'red' | 'grey' | 'gray' | 'bold' | 'green' | 'yellow' | 'cyan' | 'blue';
const STYLES: StyleName[] = ['red', 'grey', 'gray', 'bold', 'green', 'yellow', 'cyan', 'blue'];
const LEVELS = [0, 1, 2, 3] as const;

const SAMPLES = [
	'',
	'plain text',
	'with  spaces\tand\ttabs',
	'line one\nline two',
	'trailing newline\n',
	'\n',
	'\n\n',
	'CRLF\r\nline\r\n',
	'CRLF then LF\r\nand\nbreaks\r\n',
	'lone\rcarriage',
	'emoji 🚀 and ✓',
	'nul\u0000char',
	'already \u001B[31mred\u001B[39m here',
	'closing \u001B[39m code first',
	'bold \u001B[1mopen\u001B[22m close',
	'reset \u001B[0m everywhere \u001B[0m',
	'grey \u001B[90mtext\u001B[39m',
	'\u001B[39m\u001B[39m',
	'esc \u001B[39m then\nnewline \u001B[39m',
	'\r\n\u001B[39m\n',
	'\r\r\n\u001B[39m\r\n',
];

const ARG_CASES: unknown[][] = [
	[],
	['single'],
	['a', 'b'],
	['a', 'b', 'c'],
	[1],
	[0],
	[false],
	[true],
	[null],
	[undefined],
	[Number.NaN],
	['x', 1, null, undefined],
	[['a', 'b']],
	[{ toString: () => 'object' }],
	[{ [Symbol.toPrimitive]: (hint: string) => `primitive:${hint}` }],
	['prefix', { [Symbol.toPrimitive]: (hint: string) => `primitive:${hint}` }],
];

const thrownMessage = (run: () => unknown): string | null => {
	try {
		run();
		return null;
	} catch (error) {
		return (error as Error).message;
	}
};

describe('ANSI output parity with chalk', () => {
	for (const level of LEVELS) {
		test(`byte-identical output at level ${level}`, () => {
			const reference = new Chalk({ level });
			const ours = createColor({ level });

			for (const sample of SAMPLES) {
				for (const name of STYLES) {
					expect(ours[name](sample)).toBe(reference[name](sample));
					expect(ours[name].bold(sample)).toBe(reference[name].bold(sample));
					expect(ours.bold[name](sample)).toBe(reference.bold[name](sample));
					expect(ours[name][name](sample)).toBe(reference[name][name](sample));
				}
			}
		});
	}

	test('produces the exact chalk codes for the styles sshya uses', () => {
		const c = createColor({ level: 1 });
		expect(c.red('x')).toBe('\u001B[31mx\u001B[39m');
		expect(c.green('x')).toBe('\u001B[32mx\u001B[39m');
		expect(c.yellow('x')).toBe('\u001B[33mx\u001B[39m');
		expect(c.blue('x')).toBe('\u001B[34mx\u001B[39m');
		expect(c.cyan('x')).toBe('\u001B[36mx\u001B[39m');
		expect(c.grey('x')).toBe('\u001B[90mx\u001B[39m');
		expect(c.gray('x')).toBe('\u001B[90mx\u001B[39m');
		expect(c.bold('x')).toBe('\u001B[1mx\u001B[22m');
		expect(c.bold.red('x')).toBe('\u001B[1m\u001B[31mx\u001B[39m\u001B[22m');
		expect(c.red.bold('x')).toBe('\u001B[31m\u001B[1mx\u001B[22m\u001B[39m');
		expect(c.grey.bold('x')).toBe('\u001B[90m\u001B[1mx\u001B[22m\u001B[39m');
	});

	test('matches chalk for empty strings, embedded close codes and line breaks', () => {
		const c = createColor({ level: 1 });
		expect(c.red('')).toBe('');
		expect(c.red('x\u001B[39my')).toBe('\u001B[31mx\u001B[39m\u001B[31my\u001B[39m');
		expect(c.red('a\nb')).toBe('\u001B[31ma\u001B[39m\n\u001B[31mb\u001B[39m');
		expect(c.red('a\r\nb')).toBe('\u001B[31ma\u001B[39m\r\n\u001B[31mb\u001B[39m');
		expect(c.red('a\nb\nc')).toBe('\u001B[31ma\u001B[39m\n\u001B[31mb\u001B[39m\n\u001B[31mc\u001B[39m');
		expect(c.bold('a\nb')).toBe('\u001B[1ma\u001B[22m\n\u001B[1mb\u001B[22m');
	});

	test('matches chalk argument coercion', () => {
		for (const level of [0, 1] as const) {
			const reference = new Chalk({ level });
			const ours = createColor({ level });
			for (const args of ARG_CASES) {
				for (const name of STYLES) {
					expect(ours[name](...args)).toBe(reference[name](...args));
				}
			}
			expect(ours.bold.red('a', 'b')).toBe(reference.bold.red('a', 'b'));
		}
	});

	test('matches chalk level validation', () => {
		for (const level of LEVELS) {
			expect(createColor({ level }).level).toBe(level);
			expect(new Chalk({ level }).level).toBe(level);
		}
		for (const level of [4, -1, 1.5]) {
			const reference = thrownMessage(() => new Chalk({ level: level as 0 }));
			expect(thrownMessage(() => createColor({ level }))).toBe(reference);
		}
		expect(thrownMessage(() => createColor({ level: 4 }))).toBe('The `level` option should be an integer from 0 to 3');
	});

	test('honours level changes on already-created builders like chalk', () => {
		const reference = new Chalk({ level: 1 });
		const ours = createColor({ level: 1 });
		const referenceRed = reference.red;
		const oursRed = ours.red;

		reference.level = 0;
		ours.level = 0;
		expect(oursRed('x')).toBe(referenceRed('x'));
		expect(oursRed.bold('x')).toBe(referenceRed.bold('x'));

		reference.level = 2;
		ours.level = 2;
		expect(oursRed('x')).toBe(referenceRed('x'));
	});

	test('default export detects the same level as chalk', () => {
		expect(color.level).toBe(chalk.level);
		for (const name of STYLES) {
			expect(color[name]('a\r\nb')).toBe(chalk[name]('a\r\nb'));
		}
	});
});

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const probePath = path.join(os.tmpdir(), `sshya-color-probe-${process.pid}.ts`);
const chalkEntry = fileURLToPath(import.meta.resolve('chalk'));
const colorEntry = path.join(projectRoot, 'src/lib/color.ts');

fs.writeFileSync(
	probePath,
	[
		`import chalk from ${JSON.stringify(chalkEntry)};`,
		`import color from ${JSON.stringify(colorEntry)};`,
		'console.log(JSON.stringify([chalk.level, color.level]));',
	].join('\n'),
);
afterAll(() => fs.rmSync(probePath, { force: true }));

type Levels = { chalk: number; ours: number };

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const runProbe = (envDelta: Record<string, string>, args: string[] = [], pty = false): Levels => {
	const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...envDelta };
	const result = pty
		? spawnSync('script', ['-qec', [process.execPath, probePath, ...args].map(shellQuote).join(' '), '/dev/null'], {
				env,
				encoding: 'utf8',
				timeout: 20_000,
			})
		: spawnSync(process.execPath, [probePath, ...args], { env, encoding: 'utf8', timeout: 20_000 });
	const output = (result.stdout ?? '').replaceAll('\r', '');
	const match = /\[(\d+),(\d+)\]/.exec(output);
	if (!match) throw new Error(`probe failed (status ${result.status}): ${result.stdout}${result.stderr}`);
	return { chalk: Number(match[1]), ours: Number(match[2]) };
};

const NON_TTY_CASES: Array<{ name: string; env: Record<string, string>; args?: string[]; expected: number }> = [
	{ name: 'plain non-TTY gets no color', env: { TERM: 'xterm-256color' }, expected: 0 },
	{ name: 'FORCE_COLOR=0 wins', env: { TERM: 'xterm-256color', FORCE_COLOR: '0' }, expected: 0 },
	{ name: 'FORCE_COLOR=1', env: { TERM: 'dumb', FORCE_COLOR: '1' }, expected: 1 },
	{ name: 'FORCE_COLOR=2', env: { TERM: 'dumb', FORCE_COLOR: '2' }, expected: 2 },
	{ name: 'FORCE_COLOR=3', env: { TERM: 'dumb', FORCE_COLOR: '3' }, expected: 3 },
	{ name: 'FORCE_COLOR=true maps to 1', env: { TERM: 'dumb', FORCE_COLOR: 'true' }, expected: 1 },
	{ name: 'FORCE_COLOR=false maps to 0', env: { TERM: 'dumb', FORCE_COLOR: 'false' }, expected: 0 },
	{ name: 'empty FORCE_COLOR maps to 1', env: { TERM: 'dumb', FORCE_COLOR: '' }, expected: 1 },
	{ name: 'TERM checks run before FORCE_COLOR numeric value', env: { TERM: 'xterm-256color', FORCE_COLOR: '3' }, expected: 2 },
	{ name: 'invalid FORCE_COLOR falls through to TERM', env: { TERM: 'xterm-256color', FORCE_COLOR: 'bogus' }, expected: 2 },
	{ name: 'NO_COLOR alone does nothing', env: { TERM: 'xterm-256color', NO_COLOR: '1' }, expected: 0 },
	{ name: 'NO_COLOR is ignored when FORCE_COLOR is set', env: { TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '1' }, expected: 1 },
	{ name: '--color', env: { TERM: 'dumb' }, args: ['--color'], expected: 1 },
	{ name: '--colors', env: { TERM: 'dumb' }, args: ['--colors'], expected: 1 },
	{ name: '--color=true', env: { TERM: 'dumb' }, args: ['--color=true'], expected: 1 },
	{ name: '--color=always', env: { TERM: 'dumb' }, args: ['--color=always'], expected: 1 },
	{ name: '--color=256', env: { TERM: 'dumb' }, args: ['--color=256'], expected: 2 },
	{ name: '--color=16m', env: { TERM: 'dumb' }, args: ['--color=16m'], expected: 3 },
	{ name: '--color=full', env: { TERM: 'dumb' }, args: ['--color=full'], expected: 3 },
	{ name: '--color=truecolor', env: { TERM: 'dumb' }, args: ['--color=truecolor'], expected: 3 },
	{ name: '--color=false', env: { TERM: 'dumb' }, args: ['--color=false'], expected: 0 },
	{ name: '--color=never', env: { TERM: 'dumb' }, args: ['--color=never'], expected: 0 },
	{ name: '--no-color alone', env: { TERM: 'xterm-256color' }, args: ['--no-color'], expected: 0 },
	{ name: 'FORCE_COLOR overrides --no-color like chalk', env: { TERM: 'dumb', FORCE_COLOR: '3' }, args: ['--no-color'], expected: 3 },
	{ name: 'FORCE_COLOR=0 overrides --color=16m like chalk', env: { TERM: 'dumb', FORCE_COLOR: '0' }, args: ['--color=16m'], expected: 0 },
	{ name: 'TF_BUILD pipeline', env: { TERM: 'dumb', TF_BUILD: '1', AGENT_NAME: 'agent' }, expected: 1 },
];

describe('color level detection parity with chalk', () => {
	for (const testCase of NON_TTY_CASES) {
		test(`${testCase.name} (non-TTY)`, () => {
			const levels = runProbe(testCase.env, testCase.args);
			expect(levels.ours).toBe(levels.chalk);
			expect(levels.chalk).toBe(testCase.expected);
		});
	}

	const hasScript = process.platform !== 'win32' && spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0;
	const ptyCases: Array<{ name: string; env: Record<string, string>; args?: string[]; expected: number }> = [
		{ name: 'xterm-256color TTY', env: { TERM: 'xterm-256color' }, expected: 2 },
		{ name: 'TERM=dumb TTY', env: { TERM: 'dumb' }, expected: 0 },
		{ name: 'TERM=dumb TTY with FORCE_COLOR=1', env: { TERM: 'dumb', FORCE_COLOR: '1' }, expected: 1 },
		{ name: 'kitty TTY', env: { TERM: 'xterm-kitty' }, expected: 3 },
		{ name: 'ghostty TTY', env: { TERM: 'xterm-ghostty' }, expected: 3 },
		{ name: 'wezterm TTY', env: { TERM: 'wezterm' }, expected: 3 },
		{ name: 'screen 256 TTY', env: { TERM: 'screen-256color' }, expected: 2 },
		{ name: 'rxvt TTY', env: { TERM: 'rxvt-unicode' }, expected: 1 },
		{ name: 'vt100 TTY', env: { TERM: 'vt100' }, expected: 1 },
		{ name: 'linux console TTY', env: { TERM: 'linux' }, expected: 1 },
		{ name: 'ansi TTY', env: { TERM: 'ansi' }, expected: 1 },
		{ name: 'COLORTERM only', env: { TERM: 'unknown', COLORTERM: '1' }, expected: 1 },
		{ name: 'COLORTERM=truecolor', env: { TERM: 'unknown', COLORTERM: 'truecolor' }, expected: 3 },
		{ name: 'GitHub Actions', env: { TERM: 'unknown', CI: '1', GITHUB_ACTIONS: '1' }, expected: 3 },
		{ name: 'Travis', env: { TERM: 'unknown', CI: '1', TRAVIS: '1' }, expected: 1 },
		{ name: 'CI with no known vendor', env: { TERM: 'unknown', CI: '1' }, expected: 0 },
		{ name: 'TeamCity 9', env: { TERM: 'unknown', TEAMCITY_VERSION: '9.1.0' }, expected: 1 },
		{ name: 'TeamCity 8', env: { TERM: 'unknown', TEAMCITY_VERSION: '8.0.0' }, expected: 0 },
		{ name: 'iTerm 3', env: { TERM: 'unknown', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.4.0' }, expected: 3 },
		{ name: 'iTerm 2', env: { TERM: 'unknown', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '2.9.0' }, expected: 2 },
		{ name: 'Apple Terminal', env: { TERM: 'unknown', TERM_PROGRAM: 'Apple_Terminal' }, expected: 2 },
		{ name: 'NO_COLOR is ignored in a TTY', env: { TERM: 'xterm-256color', NO_COLOR: '1' }, expected: 2 },
		{ name: '--color in a TTY', env: { TERM: 'dumb' }, args: ['--color'], expected: 1 },
	];

	if (hasScript) {
		for (const testCase of ptyCases) {
			test(`${testCase.name} (PTY)`, () => {
				const levels = runProbe(testCase.env, testCase.args, true);
				expect(levels.ours).toBe(levels.chalk);
				expect(levels.chalk).toBe(testCase.expected);
			});
		}
	}
});
