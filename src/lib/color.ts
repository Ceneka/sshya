import os from 'node:os';
import tty from 'node:tty';

/**
 * Zero-dependency 1:1 replacement for the subset of chalk 5 used by sshya.
 * Mirrors chalk 5.6.2: ANSI codes, embedded-close re-opening, CRLF handling,
 * argument coercion and color-level detection. Like chalk 5, NO_COLOR is ignored.
 */

export type Color = ((...args: unknown[]) => string) &
	{ level: number } & { readonly [K in keyof typeof CODES]: Color };
const CODES = {
	bold: [1, 22], red: [31, 39], green: [32, 39], yellow: [33, 39],
	blue: [34, 39], cyan: [36, 39], grey: [90, 39], gray: [90, 39],
} as const;

type Styler = { open: string; close: string; openAll: string; closeAll: string; parent?: Styler };
type State = { level: number };
type Builder = Color & { [STATE]: State; [STYLER]?: Styler };
const STATE = Symbol('state');
const STYLER = Symbol('styler');
const createStyler = (open: string, close: string, parent?: Styler): Styler =>
	parent
		? { open, close, openAll: parent.openAll + open, closeAll: close + parent.closeAll, parent }
		: { open, close, openAll: open, closeAll: close };
// chalk keeps every match and appends the re-open code: close -> close + open.
const replaceAll = (string: string, search: string, replace: string): string => string.split(search).join(search + replace);
// chalk closes before each line break and re-opens after (CR stays inside the break).
const encaseCRLF = (string: string, prefix: string, postfix: string): string => string.replace(/\r?\n/g, lf => prefix + lf + postfix);

const applyStyle = (state: State, styler: Styler | undefined, string: string): string => {
	if (state.level <= 0 || !string || styler === undefined) return string;
	const { openAll, closeAll } = styler;
	let result = string;
	if (result.includes('\u001B')) {
		for (let current: Styler | undefined = styler; current; current = current.parent) result = replaceAll(result, current.close, current.open);
	}
	const lfIndex = result.indexOf('\n');
	if (lfIndex !== -1) result = encaseCRLF(result, closeAll, openAll);
	return openAll + result + closeAll;
};
const proto: Record<string, unknown> = {};
const makeBuilder = (state: State, styler?: Styler): Builder => {
	const builder = ((...args: unknown[]): string =>
		applyStyle(state, styler, args.length === 1 ? '' + args[0] : args.join(' '))) as Builder;
	Object.setPrototypeOf(builder, proto);
	Object.defineProperty(builder, 'level', { enumerable: true, get: () => state.level, set: (value: number) => void (state.level = value) });
	builder[STATE] = state;
	builder[STYLER] = styler;
	return builder;
};
for (const name of Object.keys(CODES) as (keyof typeof CODES)[]) {
	const [open, close] = CODES[name];
	Object.defineProperty(proto, name, {
		get(this: Builder) {
			const builder = makeBuilder(this[STATE], createStyler(`\u001B[${open}m`, `\u001B[${close}m`, this[STYLER]));
			Object.defineProperty(this, name, { value: builder });
			return builder;
		},
	});
}
const hasFlag = (flag: string): boolean => {
	const prefix = flag.startsWith('-') ? '' : flag.length === 1 ? '-' : '--';
	const position = process.argv.indexOf(prefix + flag);
	const terminator = process.argv.indexOf('--');
	return position !== -1 && (terminator === -1 || position < terminator);
};

const envForceColor = (): number | undefined => {
	const { FORCE_COLOR } = process.env;
	if (FORCE_COLOR === undefined) return undefined;
	if (FORCE_COLOR === 'true') return 1;
	if (FORCE_COLOR === 'false') return 0;
	return FORCE_COLOR.length === 0 ? 1 : Math.min(Number.parseInt(FORCE_COLOR, 10), 3);
};
let flagForceColor: number | undefined;
if (hasFlag('no-color') || hasFlag('no-colors') || hasFlag('color=false') || hasFlag('color=never')) flagForceColor = 0;
else if (hasFlag('color') || hasFlag('colors') || hasFlag('color=true') || hasFlag('color=always')) flagForceColor = 1;

const detectLevel = (streamIsTTY: boolean, sniffFlags = true): number => {
	const fromEnv = envForceColor();
	if (fromEnv !== undefined) flagForceColor = fromEnv;
	const forceColor = sniffFlags ? flagForceColor : fromEnv;
	if (forceColor === 0) return 0;
	if (sniffFlags && (hasFlag('color=16m') || hasFlag('color=full') || hasFlag('color=truecolor'))) return 3;
	if (sniffFlags && hasFlag('color=256')) return 2;
	const { env } = process;
	if (env.TF_BUILD !== undefined && env.AGENT_NAME !== undefined) return 1;
	if (!streamIsTTY && forceColor === undefined) return 0;
	const min = forceColor || 0;
	if (env.TERM === 'dumb') return min;
	if (process.platform === 'win32') {
		const release = os.release().split('.');
		if (Number(release[0]) >= 10 && Number(release[2]) >= 10_586) return Number(release[2]) >= 14_931 ? 3 : 2;
		return 1;
	}
	if ('CI' in env) {
		if (['GITHUB_ACTIONS', 'GITEA_ACTIONS', 'CIRCLECI'].some(key => key in env)) return 3;
		return ['TRAVIS', 'APPVEYOR', 'GITLAB_CI', 'BUILDKITE', 'DRONE'].some(key => key in env) || env.CI_NAME === 'codeship' ? 1 : min;
	}
	if ('TEAMCITY_VERSION' in env) return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION ?? '') ? 1 : 0;
	if (env.COLORTERM === 'truecolor') return 3;
	if (env.TERM === 'xterm-kitty' || env.TERM === 'xterm-ghostty' || env.TERM === 'wezterm') return 3;
	if (env.TERM_PROGRAM === 'iTerm.app') return Number.parseInt((env.TERM_PROGRAM_VERSION ?? '').split('.')[0] ?? '', 10) >= 3 ? 3 : 2;
	if (env.TERM_PROGRAM === 'Apple_Terminal') return 2;
	if (/-256(color)?$/i.test(env.TERM ?? '')) return 2;
	if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(env.TERM ?? '')) return 1;
	if ('COLORTERM' in env) return 1;
	return min;
};
const DEFAULT_LEVEL = detectLevel(tty.isatty(1));
/** Build a chalk-compatible instance; `level` is exposed for tests. */
export const createColor = (options: { level?: number } = {}): Color => {
	if (options.level && !(Number.isInteger(options.level) && options.level >= 0 && options.level <= 3)) {
		throw new Error('The `level` option should be an integer from 0 to 3');
	}
	return makeBuilder({ level: options.level === undefined ? DEFAULT_LEVEL : options.level });
};
export default createColor();
