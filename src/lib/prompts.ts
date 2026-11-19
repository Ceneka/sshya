/**
 * Zero-dependency interactive prompts.
 *
 * This is a hand-written replacement for the subset of `inquirer` v12 that
 * sshya uses: `input`, `confirm`, `select`, `search`, plus a `prompt()`
 * compatibility helper. The rendering model, key handling, pagination and
 * returned values are ported from `@inquirer/core` (MIT) so the interactive
 * UX stays pixel-for-pixel the same:
 *
 * - `?` prefix in blue, bold message, dim `(default)` hint
 * - green `✔` + cyan answer once submitted
 * - `❯` pointer and cyan highlight for the active select/search row
 * - dim `↑↓ navigate • ⏎ select` help line
 * - 7-row page with inquirer's looping window behaviour
 *
 * Only Node built-ins are used (`node:readline`, `node:stream`, `node:util`),
 * so the published CLI can drop the `inquirer` dependency tree. The prompt
 * functions accept an optional `{ input, output }` context (same shape as the
 * individual `@inquirer/*` packages) which makes them testable with streams.
 *
 * Deliberate omissions (the call sites do not use them): checkbox/password/
 * editor prompts, separator rows, custom themes, and vim/emacs keybindings.
 */

import * as readline from 'node:readline';
import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface PromptOutput extends NodeJS.WritableStream {
  columns?: number;
  rows?: number;
  isTTY?: boolean;
}

export interface PromptInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): void;
}

export interface PromptContext {
  input?: PromptInput;
  output?: PromptOutput;
  signal?: AbortSignal;
  /** Erase the prompt block after it is answered instead of leaving it on screen. */
  clearPromptOnDone?: boolean;
  /** Force colors on/off. Mostly useful for tests; defaults to TTY detection. */
  color?: boolean;
}

export interface SeparatorLike {
  type: 'separator';
  separator?: string;
}

export interface Choice<Value = string> {
  name?: string;
  value: Value;
  short?: string;
  description?: string;
  disabled?: boolean | string;
}

export type ChoiceInput<Value = string> = string | Choice<Value> | SeparatorLike;

export type Validate<Value> = (value: Value) => boolean | string | Promise<boolean | string>;

export interface InputConfig {
  message: string;
  default?: string;
  /** `tab` (default) fills the default on Tab; `editable` prefills it for editing. */
  prefill?: 'tab' | 'editable';
  validate?: Validate<string>;
  transformer?: (value: string, context: { isFinal: boolean }) => string;
  required?: boolean;
  pattern?: RegExp;
  patternError?: string;
}

export interface ConfirmConfig {
  message: string;
  default?: boolean;
  transformer?: (value: boolean) => string;
}

export interface SelectConfig<Value = string> {
  message: string;
  choices: readonly ChoiceInput<Value>[];
  pageSize?: number;
  loop?: boolean;
  default?: Value;
}

export interface SearchConfig<Value = string> {
  message: string;
  source: (
    term: string | undefined,
    options: { signal: AbortSignal },
  ) => Promise<readonly ChoiceInput<Value>[]>;
  pageSize?: number;
  validate?: Validate<Value>;
}

export class ExitPromptError extends Error {
  override name = 'ExitPromptError';
}

export class AbortPromptError extends Error {
  override name = 'AbortPromptError';

  constructor(options?: { cause?: unknown }) {
    super('Prompt was aborted');
    this.cause = options?.cause;
  }
}

export class CancelPromptError extends Error {
  override name = 'CancelPromptError';
  override message = 'Prompt was canceled';
}

export class ValidationError extends Error {
  override name = 'ValidationError';
}

/* -------------------------------------------------------------------------- */
/* ANSI helpers                                                               */
/* -------------------------------------------------------------------------- */

const ESC = '\u001B[';
const cursorLeft = `${ESC}G`;
const cursorHide = `${ESC}?25l`;
const cursorShow = `${ESC}?25h`;
const cursorUp = (rows = 1): string => (rows > 0 ? `${ESC}${rows}A` : '');
const cursorDown = (rows = 1): string => (rows > 0 ? `${ESC}${rows}B` : '');
const cursorTo = (x: number): string => `${ESC}${x + 1}G`;
const eraseLine = `${ESC}2K`;
const eraseLines = (lines: number): string =>
  lines > 0 ? (eraseLine + cursorUp(1)).repeat(lines - 1) + eraseLine + cursorLeft : '';

/** `@inquirer/figures` unicode detection for the two glyphs sshya renders. */
const isUnicodeSupported = (): boolean => {
  if (process.platform !== 'win32') {
    return process.env.TERM !== 'linux';
  }
  return Boolean(
    process.env.WT_SESSION ||
      process.env.TERMINUS_SUBLIME ||
      process.env.ConEmuTask === '{cmd::Cmder}' ||
      process.env.TERM_PROGRAM === 'Terminus-Sublime' ||
      process.env.TERM_PROGRAM === 'vscode' ||
      process.env.TERM === 'xterm-256color' ||
      process.env.TERM === 'alacritty' ||
      process.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm',
  );
};

const unicode = isUnicodeSupported();
const figures = {
  tick: unicode ? '✔' : '√',
  pointer: unicode ? '❯' : '>',
};

/** @inquirer/core's spinner, shown only after 300 ms of loading. */
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/* -------------------------------------------------------------------------- */
/* Colors                                                                     */
/* -------------------------------------------------------------------------- */

interface Palette {
  blue(text: string): string;
  green(text: string): string;
  cyan(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
}

const identity = (text: string): string => text;

const createPalette = (enabled: boolean): Palette => {
  const sgr = (open: number, close: number): ((text: string) => string) =>
    enabled ? (text: string): string => `\u001B[${open}m${text}\u001B[${close}m` : identity;

  return {
    blue: sgr(34, 39),
    green: sgr(32, 39),
    cyan: sgr(36, 39),
    red: sgr(31, 39),
    yellow: sgr(33, 39),
    bold: sgr(1, 22),
    dim: sgr(2, 22),
  };
};

const colorsEnabled = (output: PromptOutput, override?: boolean): boolean => {
  if (override !== undefined) {
    return override;
  }
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '') {
    return force !== '0';
  }
  if (force === '') {
    return true;
  }
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }
  if (process.env.TERM === 'dumb') {
    return false;
  }
  return Boolean(output.isTTY);
};

/* -------------------------------------------------------------------------- */
/* Text width / wrapping                                                      */
/* -------------------------------------------------------------------------- */

const ANSI_SEQUENCE = /^\u001B\[[0-9;?]*[A-Za-z]/;

const outputWidth = (output: PromptOutput): number => {
  const columns = output.columns;
  return typeof columns === 'number' && Number.isFinite(columns) && columns > 0
    ? Math.floor(columns)
    : 80;
};

const visibleLength = (text: string): number => stripVTControlCharacters(text).length;

/** Hard-wrap a single line at `width` visible characters, preserving ANSI codes. */
const wrapLine = (line: string, width: number): string[] => {
  if (visibleLength(line) <= width) {
    return [line.trimEnd()];
  }

  const lines: string[] = [];
  let current = '';
  let visible = 0;
  let index = 0;

  while (index < line.length) {
    const ansi = ANSI_SEQUENCE.exec(line.slice(index));
    if (ansi) {
      current += ansi[0];
      index += ansi[0].length;
      continue;
    }

    const codePoint = line.codePointAt(index);
    const character = codePoint === undefined ? '' : String.fromCodePoint(codePoint);
    if (character === '') {
      break;
    }

    if (visible >= width) {
      lines.push(current.trimEnd());
      current = '';
      visible = 0;
    }

    current += character;
    visible += 1;
    index += character.length;
  }

  lines.push(current.trimEnd());
  return lines;
};

const breakLines = (content: string, width: number): string =>
  content
    .split('\n')
    .flatMap(line => wrapLine(line, width))
    .join('\n');

/* -------------------------------------------------------------------------- */
/* Muted output (inquirer's MuteStream stand-in)                              */
/* -------------------------------------------------------------------------- */

/**
 * Readline echoes typed characters and cursor movement to its output. inquirer
 * mutes that stream and draws the prompt itself; this Writable does the same
 * while proxying the terminal geometry readline needs.
 */
class MuteOutput extends Writable {
  private muted = false;

  constructor(private readonly target: PromptOutput) {
    super({ decodeStrings: false });
  }

  get isTTY(): boolean {
    return Boolean(this.target.isTTY);
  }

  get columns(): number | undefined {
    return this.target.columns;
  }

  get rows(): number | undefined {
    return this.target.rows;
  }

  getColorDepth(env?: NodeJS.ProcessEnv): number {
    const target = this.target as PromptOutput & {
      getColorDepth?: (environment?: NodeJS.ProcessEnv) => number;
    };
    return typeof target.getColorDepth === 'function' ? target.getColorDepth(env) : 1;
  }

  hasColors(depth?: number): boolean {
    const target = this.target as PromptOutput & { hasColors?: (level?: number) => boolean };
    return typeof target.hasColors === 'function' ? target.hasColors(depth) : false;
  }

  mute(): this {
    this.muted = true;
    return this;
  }

  unmute(): this {
    this.muted = false;
    return this;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) {
      try {
        this.target.write(chunk);
      } catch {
        // A closed output stream must not take down the prompt cleanup.
      }
    }
    callback();
  }
}

/* -------------------------------------------------------------------------- */
/* Screen manager (ported from @inquirer/core)                                */
/* -------------------------------------------------------------------------- */

/**
 * Keeps track of how many lines the current prompt occupies and erases them
 * before every re-render, exactly like inquirer's ScreenManager. The cursor is
 * put back on the prompt's input row so readline keeps editing in place.
 */
class ScreenManager {
  private height = 0;
  private extraLinesUnderPrompt = 0;
  private cursorPos: { rows: number; cols: number };

  constructor(
    private readonly rl: ReadlineInterface,
    private readonly output: MuteOutput,
    private readonly width: () => number,
  ) {
    this.cursorPos = this.rl.getCursorPos();
  }

  private static countLines(content: string): number {
    return content.split('\n').length;
  }

  private write(content: string): void {
    this.output.unmute();
    this.output.write(content);
    this.output.mute();
  }

  render(content: string, bottomContent = ''): void {
    const promptLine = content.split('\n').pop() ?? '';
    const rawPromptLine = stripVTControlCharacters(promptLine);

    // Readline appends its own line buffer after the prompt. The rendered
    // content already contains that text, so strip it from the prompt we hand
    // to readline to avoid measuring it twice.
    let prompt = rawPromptLine;
    if (this.rl.line.length > 0) {
      prompt = prompt.slice(0, -this.rl.line.length);
    }
    this.rl.setPrompt(prompt);
    this.cursorPos = this.rl.getCursorPos();

    const width = this.width();
    content = breakLines(content, width);
    bottomContent = breakLines(bottomContent, width);

    // Prevent the cursor from painting on the first column of the next line.
    if (rawPromptLine.length % width === 0) {
      content += '\n';
    }

    let output = content + (bottomContent ? `\n${bottomContent}` : '');

    // Parts of the prompt line below the cursor count as bottom content so
    // they are erased and re-rendered correctly.
    const promptLineUpDiff = Math.floor(rawPromptLine.length / width) - this.cursorPos.rows;
    const bottomContentHeight =
      promptLineUpDiff + (bottomContent ? ScreenManager.countLines(bottomContent) : 0);
    if (bottomContentHeight > 0) {
      output += cursorUp(bottomContentHeight);
    }
    output += cursorTo(this.cursorPos.cols);

    this.write(cursorDown(this.extraLinesUnderPrompt) + eraseLines(this.height) + output);
    this.extraLinesUnderPrompt = bottomContentHeight;
    this.height = ScreenManager.countLines(output);
  }

  checkCursorPos(): void {
    const cursorPos = this.rl.getCursorPos();
    if (cursorPos.cols !== this.cursorPos.cols) {
      this.write(cursorTo(cursorPos.cols));
      this.cursorPos = cursorPos;
    }
  }

  done(options: { clearContent: boolean }): void {
    this.rl.setPrompt('');
    let output = cursorDown(this.extraLinesUnderPrompt);
    output += options.clearContent ? eraseLines(this.height) : '\n';
    output += cursorShow;
    this.write(output);
    this.rl.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Choices                                                                    */
/* -------------------------------------------------------------------------- */

interface NormalizedChoice<Value> {
  value: Value;
  name: string;
  short: string;
  disabled: boolean | string;
  description?: string;
}

const isSeparator = (choice: unknown): choice is SeparatorLike =>
  Boolean(
    choice &&
      typeof choice === 'object' &&
      'type' in choice &&
      (choice as { type?: unknown }).type === 'separator',
  );

const normalizeChoices = <Value>(choices: readonly ChoiceInput<Value>[]): NormalizedChoice<Value>[] => {
  const normalized: NormalizedChoice<Value>[] = [];

  for (const choice of choices) {
    if (isSeparator(choice)) {
      // Separators are accepted for API familiarity but treated as disabled
      // rows, since the sshya prompts never render grouping headers.
      normalized.push({
        value: undefined as Value,
        name: choice.separator ?? '',
        short: choice.separator ?? '',
        disabled: true,
      });
      continue;
    }

    if (typeof choice === 'string') {
      normalized.push({
        value: choice as unknown as Value,
        name: choice,
        short: choice,
        disabled: false,
      });
      continue;
    }

    const name = choice.name ?? String(choice.value);
    normalized.push({
      value: choice.value,
      name,
      short: choice.short ?? name,
      disabled: choice.disabled ?? false,
      ...(choice.description ? { description: choice.description } : {}),
    });
  }

  return normalized;
};

const isSelectable = <Value>(choice: NormalizedChoice<Value> | undefined): choice is NormalizedChoice<Value> =>
  choice !== undefined && choice.disabled === false;

const findBounds = <Value>(items: readonly NormalizedChoice<Value>[]): { first: number; last: number } => {
  const first = items.findIndex(item => isSelectable(item));
  const last = items.findLastIndex(item => isSelectable(item));
  return { first, last };
};

/** Move one selectable row in `offset` direction, wrapping unless bounded. */
const moveActive = (
  items: readonly NormalizedChoice<unknown>[],
  active: number,
  offset: -1 | 1,
): number => {
  let next = active;
  // Inquirer's do/while can spin forever when the only selectable row is the
  // current one; bound the scan so a single-choice prompt stays usable.
  for (let step = 0; step < items.length; step++) {
    next = (next + offset + items.length) % items.length;
    if (isSelectable(items[next])) {
      return next;
    }
  }
  return active;
};

/* -------------------------------------------------------------------------- */
/* Pagination (ported from @inquirer/core usePagination)                      */
/* -------------------------------------------------------------------------- */

type RenderItem<Value> = (
  item: NormalizedChoice<Value> | undefined,
  isActive: boolean,
  index: number,
) => string;

class Paginator<Value> {
  private lastPointer: number | undefined;
  private lastActive: number | undefined;

  constructor(
    private readonly pageSize: number,
    private readonly loop: boolean,
  ) {}

  private pointerPosition(renderedItems: string[][], active: number): number {
    if (this.lastPointer === undefined) {
      this.lastPointer = active;
    }

    const middle = Math.floor(this.pageSize / 2);
    const renderedLength = renderedItems.reduce((total, item) => total + item.length, 0);
    const defaultPointerPosition = renderedItems
      .slice(0, active)
      .reduce((total, item) => total + item.length, 0);

    let pointer = defaultPointerPosition;

    if (renderedLength > this.pageSize) {
      if (this.loop) {
        // Keep the pointer where it was and move it towards the middle as the
        // user walks down; when walking up, leave it alone.
        pointer = this.lastPointer;
        if (
          this.lastActive !== undefined &&
          this.lastActive < active &&
          active - this.lastActive < this.pageSize
        ) {
          pointer = Math.min(
            middle,
            Math.abs(active - this.lastActive) === 1
              ? Math.min(
                  this.lastPointer + (renderedItems[this.lastActive]?.length ?? 0),
                  Math.max(defaultPointerPosition, this.lastPointer),
                )
              : this.lastPointer + active - this.lastActive,
          );
        }
      } else {
        const spaceUnderActive = renderedItems
          .slice(active)
          .reduce((total, item) => total + item.length, 0);
        pointer =
          spaceUnderActive < this.pageSize - middle
            ? this.pageSize - spaceUnderActive
            : Math.min(defaultPointerPosition, middle);
      }
    }

    this.lastPointer = pointer;
    this.lastActive = active;
    return pointer;
  }

  page(
    items: readonly NormalizedChoice<Value>[],
    active: number,
    renderItem: RenderItem<Value>,
    width: number,
  ): string {
    if (items.length === 0) {
      return '';
    }

    const bound = (num: number): number => ((num % items.length) + items.length) % items.length;
    const renderedItems = items.map((item, index) =>
      breakLines(renderItem(item, index === active, index), width).split('\n'),
    );
    const renderedLength = renderedItems.reduce((total, item) => total + item.length, 0);
    const renderItemAtIndex = (index: number): string[] => renderedItems[index] ?? [];
    const pointer = this.pointerPosition(renderedItems, active);

    // Put the active item at the pointer, then fill below and above it.
    const activeItem = renderItemAtIndex(active).slice(0, this.pageSize);
    const activeItemPosition =
      pointer + activeItem.length <= this.pageSize ? pointer : this.pageSize - activeItem.length;

    const pageBuffer: Array<string | undefined> = new Array(this.pageSize);
    pageBuffer.splice(activeItemPosition, activeItem.length, ...activeItem);
    const itemVisited = new Set([active]);

    let bufferPointer = activeItemPosition + activeItem.length;
    let itemPointer = bound(active + 1);
    while (
      bufferPointer < this.pageSize &&
      !itemVisited.has(itemPointer) &&
      (this.loop && renderedLength > this.pageSize ? itemPointer !== active : itemPointer > active)
    ) {
      const lines = renderItemAtIndex(itemPointer);
      const linesToAdd = lines.slice(0, this.pageSize - bufferPointer);
      pageBuffer.splice(bufferPointer, linesToAdd.length, ...linesToAdd);
      itemVisited.add(itemPointer);
      bufferPointer += linesToAdd.length;
      itemPointer = bound(itemPointer + 1);
    }

    bufferPointer = activeItemPosition - 1;
    itemPointer = bound(active - 1);
    while (
      bufferPointer >= 0 &&
      !itemVisited.has(itemPointer) &&
      (this.loop && renderedLength > this.pageSize ? itemPointer !== active : itemPointer < active)
    ) {
      const lines = renderItemAtIndex(itemPointer);
      const linesToAdd = lines.slice(Math.max(0, lines.length - bufferPointer - 1));
      pageBuffer.splice(bufferPointer - linesToAdd.length + 1, linesToAdd.length, ...linesToAdd);
      itemVisited.add(itemPointer);
      bufferPointer -= linesToAdd.length;
      itemPointer = bound(itemPointer - 1);
    }

    return pageBuffer.filter((line): line is string => typeof line === 'string').join('\n');
  }
}

/* -------------------------------------------------------------------------- */
/* Session                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The runtime readline interface exposes `input` and `clearLine()`; some
 * bundled Node typings omit them even though both have existed for years.
 */
type ReadlineInterface = readline.Interface & {
  input: NodeJS.ReadableStream & {
    on(event: 'keypress', listener: (value: string | undefined, key: readline.Key) => void): unknown;
    removeListener(
      event: 'keypress',
      listener: (value: string | undefined, key: readline.Key) => void,
    ): unknown;
  };
  clearLine(direction: -1 | 0 | 1): void;
};

type Status = 'idle' | 'done';

interface SessionOptions<T> {
  context?: PromptContext;
  clearPromptOnDone?: boolean;
  view: () => string | [string, string];
  onKey: (key: readline.Key) => void | Promise<void>;
  onStart?: () => void;
}

/**
 * Owns the readline interface, screen manager, promise lifecycle and terminal
 * cleanup for a single prompt.
 */
class PromptSession<T> {
  readonly rl: ReadlineInterface;
  readonly palette: Palette;

  readonly promise: Promise<T>;

  private readonly input: PromptInput;
  private readonly output: PromptOutput;
  private readonly mute: MuteOutput;
  private readonly screen: ScreenManager;
  private readonly keyInput: NodeJS.ReadableStream;
  private readonly wasRaw: boolean;
  private readonly cleanupTasks: Array<() => void> = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly resolvePromise: (value: T) => void;
  private readonly rejectPromise: (error: unknown) => void;
  private readonly view: () => string | [string, string];
  private readonly onKey: (key: readline.Key) => void | Promise<void>;
  private readonly onStart?: () => void;
  private readonly clearPromptOnDone: boolean;

  private settled = false;
  private cleaned = false;
  private loading = false;
  private spinnerVisible = false;
  private spinnerTick = 0;
  private spinnerDelay: ReturnType<typeof setTimeout> | undefined;
  private spinnerInterval: ReturnType<typeof setInterval> | undefined;

  constructor(options: SessionOptions<T>) {
    this.view = options.view;
    this.onKey = options.onKey;
    this.onStart = options.onStart;

    const context = options.context ?? {};
    this.input = context.input ?? process.stdin;
    this.output = context.output ?? process.stdout;
    this.wasRaw = Boolean(this.input.isRaw);
    this.clearPromptOnDone = options.clearPromptOnDone ?? Boolean(context.clearPromptOnDone);

    const { promise, resolve, reject } = withResolvers<T>();
    this.promise = promise;
    this.resolvePromise = resolve;
    this.rejectPromise = reject;

    this.palette = createPalette(colorsEnabled(this.output, context.color));
    this.mute = new MuteOutput(this.output);

    this.rl = readline.createInterface({
      terminal: true,
      input: this.input as NodeJS.ReadableStream,
      output: this.mute,
    }) as ReadlineInterface;
    this.keyInput = this.rl.input;
    this.screen = new ScreenManager(this.rl, this.mute, () => this.pageWidth);

    // Readline emits SIGINT on Ctrl+C in raw mode; inquirer turns that into an
    // ExitPromptError so callers can clean up instead of being killed.
    const onSigint = (): void => this.fail(new ExitPromptError());
    this.rl.on('SIGINT', onSigint);
    this.cleanupTasks.push(() => this.rl.removeListener('SIGINT', onSigint));

    // Inquirer hangs if a non-TTY stdin reaches EOF (e.g. `</dev/null`).
    // Reject instead, which is the only sensible non-interactive behaviour.
    const onEnd = (): void => this.fail(new ExitPromptError());
    this.input.on('end', onEnd);
    this.cleanupTasks.push(() => this.input.removeListener('end', onEnd));

    // Ctrl+D closes readline without resolving the prompt.
    const onClose = (): void => {
      if (!this.settled) {
        this.fail(new ExitPromptError());
      }
    };
    this.rl.on('close', onClose);
    this.cleanupTasks.push(() => this.rl.removeListener('close', onClose));

    const checkCursor = (): void => this.screen.checkCursorPos();
    this.keyInput.on('keypress', checkCursor);
    this.cleanupTasks.push(() => this.keyInput.removeListener('keypress', checkCursor));

    const onKeypress = (_value: string | undefined, key: readline.Key): void => {
      if (this.settled) {
        return;
      }
      try {
        // Ctrl+C may arrive as a keypress without readline's SIGINT on some
        // runtimes; handle it defensively.
        if (key?.ctrl && key.name === 'c') {
          this.fail(new ExitPromptError());
          return;
        }
        const result = this.onKey(key);
        if (result && typeof (result as Promise<void>).then === 'function') {
          void (result as Promise<void>).catch(error => this.fail(error));
        }
      } catch (error) {
        this.fail(error);
      }
    };
    this.keyInput.on('keypress', onKeypress);
    this.cleanupTasks.push(() => this.keyInput.removeListener('keypress', onKeypress));

    // escExit calls process.exit() straight from its own keypress handler, so
    // the prompt never rejects. Put the terminal back before the process dies.
    const onProcessExit = (): void => {
      try {
        this.output.write(cursorShow);
      } catch {
        // Output may already be gone.
      }
      if (this.input.isTTY && typeof this.input.setRawMode === 'function') {
        try {
          this.input.setRawMode(false);
        } catch {
          // Ignore.
        }
      }
    };
    process.on('exit', onProcessExit);
    this.cleanupTasks.push(() => process.removeListener('exit', onProcessExit));

    if (context.signal) {
      const signal = context.signal;
      const onAbort = (): void =>
        this.fail(new AbortPromptError({ cause: signal.reason }));
      if (signal.aborted) {
        queueMicrotask(onAbort);
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        this.cleanupTasks.push(() => signal.removeEventListener('abort', onAbort));
      }
    }
  }

  start(): void {
    try {
      this.render();
      this.onStart?.();
    } catch (error) {
      this.fail(error);
    }
  }

  /** Register cleanup for prompt-specific resources (search abort controllers). */
  onCleanup(task: () => void): void {
    this.cleanupTasks.push(task);
  }

  setTimer(callback: () => void, delay: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.settled) {
        callback();
      }
    }, delay);
    this.timers.add(timer);
  }

  /** Read per render, like inquirer's `cli-width` call, so resizes are honored. */
  get pageWidth(): number {
    return outputWidth(this.output);
  }

  setLoading(loading: boolean): void {
    if (this.loading === loading) {
      return;
    }
    this.loading = loading;

    if (loading) {
      // inquirer delays the spinner by 300 ms to avoid flicker on fast calls.
      this.spinnerDelay = setTimeout(() => {
        this.spinnerVisible = true;
        this.spinnerTick = 0;
        this.spinnerInterval = setInterval(() => {
          this.spinnerTick = (this.spinnerTick + 1) % spinnerFrames.length;
          if (!this.settled) {
            this.render();
          }
        }, 80);
        this.render();
      }, 300);
      return;
    }

    if (this.spinnerDelay !== undefined) {
      clearTimeout(this.spinnerDelay);
      this.spinnerDelay = undefined;
    }
    if (this.spinnerInterval !== undefined) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = undefined;
    }
    this.spinnerVisible = false;
    this.spinnerTick = 0;
  }

  prefix(status: Status): string {
    if (this.loading && this.spinnerVisible) {
      return this.palette.yellow(spinnerFrames[this.spinnerTick] ?? spinnerFrames[0] ?? '');
    }
    return status === 'done' ? this.palette.green(figures.tick) : this.palette.blue('?');
  }

  render(): void {
    this.renderNow();
  }

  get isSettled(): boolean {
    return this.settled;
  }

  finish(value: T): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    try {
      this.renderNow();
    } catch (error) {
      this.cleanup();
      this.rejectPromise(error);
      return;
    }
    this.cleanup();
    this.resolvePromise(value);
  }

  fail(error: unknown): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.cleanup();
    this.rejectPromise(error);
  }

  private renderNow(): void {
    const view = this.view();
    const [content, bottomContent] = typeof view === 'string' ? [view, ''] : view;
    this.screen.render(content, bottomContent);
  }

  private cleanup(): void {
    if (this.cleaned) {
      return;
    }
    this.cleaned = true;

    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    if (this.spinnerDelay !== undefined) {
      clearTimeout(this.spinnerDelay);
      this.spinnerDelay = undefined;
    }
    if (this.spinnerInterval !== undefined) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = undefined;
    }

    for (const task of this.cleanupTasks) {
      try {
        task();
      } catch {
        // Cleanup must never mask the prompt result.
      }
    }

    try {
      this.screen.done({ clearContent: this.clearPromptOnDone });
    } catch {
      // If readline is already gone, at least leave the terminal usable.
      try {
        this.mute.unmute();
        this.mute.write(cursorShow);
        this.rl.close();
      } catch {
        // Ignore.
      }
    }

    const input = this.input;
    if (input.isTTY && typeof input.setRawMode === 'function' && input.isRaw !== this.wasRaw) {
      try {
        input.setRawMode(this.wasRaw);
      } catch {
        // Ignore a terminal that disappeared.
      }
    }

    // Keep the muted wrapper alive: readline can still flush a late write
    // while closing, and ending it here turns that into "write after end".
    this.mute.mute();
  }
}

const withResolvers = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/* -------------------------------------------------------------------------- */
/* Key helpers                                                                */
/* -------------------------------------------------------------------------- */

const isEnterKey = (key: readline.Key): boolean => key.name === 'enter' || key.name === 'return';
const isTabKey = (key: readline.Key): boolean => key.name === 'tab';
const isBackspaceKey = (key: readline.Key): boolean => key.name === 'backspace';
const isUpKey = (key: readline.Key): boolean => key.name === 'up';
const isDownKey = (key: readline.Key): boolean => key.name === 'down';
const isNumberKey = (key: readline.Key): boolean =>
  key.name !== undefined && '1234567890'.includes(key.name);

/* -------------------------------------------------------------------------- */
/* input                                                                      */
/* -------------------------------------------------------------------------- */

export async function input(config: InputConfig, context?: PromptContext): Promise<string> {
  let status: Status = 'idle';
  let value = '';
  let defaultValue = config.default;
  let errorMessage: string | undefined;
  let busy = false;

  const validate = async (candidate: string): Promise<true | string> => {
    if (config.required && !candidate) {
      return 'You must provide a value';
    }
    if (config.pattern && !config.pattern.test(candidate)) {
      return config.patternError ?? 'Invalid input';
    }
    if (typeof config.validate === 'function') {
      const result = await config.validate(candidate);
      return result === true ? true : result || 'You must provide a valid value';
    }
    return true;
  };

  let session!: PromptSession<string>;

  session = new PromptSession<string>({
    context,
    clearPromptOnDone: context?.clearPromptOnDone,
    view: () => {
      const message = session.palette.bold(config.message);
      let formattedValue = value;
      if (typeof config.transformer === 'function') {
        formattedValue = config.transformer(value, { isFinal: status === 'done' });
      } else if (status === 'done') {
        formattedValue = session.palette.cyan(value);
      }

      const defaultStr =
        defaultValue && status !== 'done' && !value
          ? session.palette.dim(`(${defaultValue})`)
          : undefined;
      const error = errorMessage ? session.palette.red(`> ${errorMessage}`) : '';
      const line = [session.prefix(status), message, defaultStr, formattedValue]
        .filter(part => part !== undefined)
        .join(' ');
      return [line, error];
    },
    onKey: key => {
      if (busy || status !== 'idle') {
        return;
      }

      if (isEnterKey(key)) {
        const answer = value || defaultValue || '';
        busy = true;
        session.setLoading(true);
        session.render();
        void validate(answer)
          .then(valid => {
            busy = false;
            session.setLoading(false);
            if (valid === true) {
              value = answer;
              status = 'done';
              session.finish(answer);
              return;
            }
            // Keep the text editable on failure (inquirer's default mode).
            session.rl.write(value);
            errorMessage = valid;
            session.render();
          })
          .catch(error => session.fail(error));
        return;
      }

      if (isBackspaceKey(key) && !value) {
        defaultValue = undefined;
        session.render();
        return;
      }

      if (isTabKey(key) && !value) {
        const fallback = defaultValue;
        defaultValue = undefined;
        session.rl.clearLine(0);
        if (fallback !== undefined) {
          session.rl.write(fallback);
        }
        value = fallback ?? '';
        session.render();
        return;
      }

      value = session.rl.line;
      errorMessage = undefined;
      session.render();
    },
    onStart: () => {
      if (config.prefill === 'editable' && defaultValue) {
        session.rl.write(defaultValue);
        value = defaultValue;
        session.render();
      }
    },
  });

  session.start();
  return session.promise;
}

/* -------------------------------------------------------------------------- */
/* confirm                                                                    */
/* -------------------------------------------------------------------------- */

const boolToString = (value: boolean): string => (value ? 'Yes' : 'No');

const getBooleanValue = (value: string, defaultValue: boolean | undefined): boolean => {
  let answer = defaultValue !== false;
  if (/^(y|yes)/i.test(value)) {
    answer = true;
  } else if (/^(n|no)/i.test(value)) {
    answer = false;
  }
  return answer;
};

export async function confirm(config: ConfirmConfig, context?: PromptContext): Promise<boolean> {
  let status: Status = 'idle';
  let value = '';
  const transformer = config.transformer ?? boolToString;

  let session!: PromptSession<boolean>;

  session = new PromptSession<boolean>({
    context,
    clearPromptOnDone: context?.clearPromptOnDone,
    view: () => {
      const message = session.palette.bold(config.message);
      let formattedValue = value;
      let defaultHint = '';
      if (status === 'done') {
        formattedValue = session.palette.cyan(value);
      } else {
        defaultHint = ` ${session.palette.dim(`(${config.default === false ? 'y/N' : 'Y/n'})`)}`;
      }
      return `${session.prefix(status)} ${message}${defaultHint} ${formattedValue}`;
    },
    onKey: key => {
      if (status !== 'idle') {
        return;
      }

      if (isEnterKey(key)) {
        const answer = getBooleanValue(value, config.default);
        value = transformer(answer);
        status = 'done';
        session.finish(answer);
        return;
      }

      if (isTabKey(key)) {
        const answer = boolToString(!getBooleanValue(value, config.default));
        session.rl.clearLine(0);
        session.rl.write(answer);
        value = answer;
        session.render();
        return;
      }

      value = session.rl.line;
      session.render();
    },
  });

  session.start();
  return session.promise;
}

/* -------------------------------------------------------------------------- */
/* select                                                                     */
/* -------------------------------------------------------------------------- */

const helpLine = (palette: Palette): string =>
  `${palette.bold('↑↓')} ${palette.dim('navigate')}${palette.dim(' • ')}${palette.bold('⏎')} ${palette.dim('select')}`;

export async function select<Value = string>(
  config: SelectConfig<Value>,
  context?: PromptContext,
): Promise<Value> {
  const pageSize = config.pageSize ?? 7;
  const loop = config.loop ?? true;
  const items = normalizeChoices(config.choices);
  const bounds = findBounds(items);

  if (bounds.first === -1) {
    throw new ValidationError('[select prompt] No selectable choices. All choices are disabled.');
  }

  const hasDefault = Object.prototype.hasOwnProperty.call(config, 'default');
  const defaultIndex = hasDefault
    ? items.findIndex(item => isSelectable(item) && item.value === config.default)
    : -1;

  let status: Status = 'idle';
  let active = defaultIndex === -1 ? bounds.first : defaultIndex;
  const paginator = new Paginator<Value>(pageSize, loop);
  let clearLineTimer: ReturnType<typeof setTimeout> | undefined;

  let session!: PromptSession<Value>;

  const selectedChoice = (): NormalizedChoice<Value> => items[active] as NormalizedChoice<Value>;

  // Inquirer restarts the 700 ms "clear the search buffer" timer on every key.
  const scheduleClearLine = (): void => {
    if (clearLineTimer !== undefined) {
      clearTimeout(clearLineTimer);
    }
    clearLineTimer = setTimeout(() => {
      clearLineTimer = undefined;
      if (!session.isSettled) {
        session.rl.clearLine(0);
      }
    }, 700);
  };

  session = new PromptSession<Value>({
    context,
    clearPromptOnDone: context?.clearPromptOnDone,
    view: () => {
      const message = session.palette.bold(config.message);
      const choice = selectedChoice();

      if (status === 'done') {
        return [session.prefix(status), message, session.palette.cyan(choice.short)]
          .filter(Boolean)
          .join(' ');
      }

      const page = paginator.page(
        items,
        active,
        (item, isActive) => {
          if (!item) {
            return '';
          }
          if (item.disabled !== false) {
            const label = typeof item.disabled === 'string' ? item.disabled : '(disabled)';
            return session.palette.dim(`- ${item.name} ${label}`);
          }
          const row = `${isActive ? figures.pointer : ' '} ${item.name}`;
          return isActive ? session.palette.cyan(row) : row;
        },
        session.pageWidth,
      );

      const lines = [
        [session.prefix(status), message].filter(Boolean).join(' '),
        page,
        ' ',
        choice.description ? session.palette.cyan(choice.description) : '',
        helpLine(session.palette),
      ]
        .filter(Boolean)
        .join('\n')
        .trimEnd();

      return `${lines}${cursorHide}`;
    },
    onKey: key => {
      if (status !== 'idle') {
        return;
      }

      if (isEnterKey(key)) {
        status = 'done';
        session.finish(selectedChoice().value);
        return;
      }

      if (isUpKey(key) || isDownKey(key)) {
        session.rl.clearLine(0);
        if (
          loop ||
          (isUpKey(key) && active !== bounds.first) ||
          (isDownKey(key) && active !== bounds.last)
        ) {
          const next = moveActive(items, active, isUpKey(key) ? -1 : 1);
          if (next !== active) {
            active = next;
            session.render();
          }
        }
        return;
      }

      if (isNumberKey(key) && !Number.isNaN(Number(session.rl.line))) {
        const selectedIndex = Number(session.rl.line) - 1;
        const item = items[selectedIndex];
        if (item && isSelectable(item) && selectedIndex !== active) {
          active = selectedIndex;
          session.render();
        }
        scheduleClearLine();
        return;
      }

      if (isBackspaceKey(key)) {
        session.rl.clearLine(0);
        return;
      }

      // Type-to-filter: move to the first row whose name starts with the
      // current (transient) input line. Inquirer keeps the line for 700 ms.
      const term = session.rl.line.toLowerCase();
      const match = items.findIndex(item => isSelectable(item) && item.name.toLowerCase().startsWith(term));
      if (match !== -1 && match !== active) {
        active = match;
        session.render();
      }
      scheduleClearLine();
    },
  });

  session.onCleanup(() => {
    if (clearLineTimer !== undefined) {
      clearTimeout(clearLineTimer);
      clearLineTimer = undefined;
    }
  });
  session.start();
  return session.promise;
}

/* -------------------------------------------------------------------------- */
/* search                                                                     */
/* -------------------------------------------------------------------------- */

export async function search<Value = string>(
  config: SearchConfig<Value>,
  context?: PromptContext,
): Promise<Value> {
  const pageSize = config.pageSize ?? 7;
  const validate = config.validate ?? ((): true => true);

  let status: Status | 'loading' = 'loading';
  let searchTerm = '';
  let searchResults: NormalizedChoice<Value>[] = [];
  let searchError: string | undefined;
  let active: number | undefined;
  let controller: AbortController | undefined;

  const paginator = new Paginator<Value>(pageSize, false);

  let session!: PromptSession<Value>;

  const firstSelectable = (): number => findBounds(searchResults).first;

  const selectedChoice = (): NormalizedChoice<Value> | undefined => {
    const index = active === undefined ? firstSelectable() : active;
    return index >= 0 ? searchResults[index] : undefined;
  };

  const loadResults = (term: string): void => {
    controller?.abort();
    const local = new AbortController();
    controller = local;

    const alreadyLoading = status === 'loading';
    status = 'loading';
    searchError = undefined;
    session.setLoading(true);
    if (!alreadyLoading) {
      session.render();
    }

    let fetched: Promise<readonly ChoiceInput<Value>[]>;
    try {
      fetched = Promise.resolve(config.source(term || undefined, { signal: local.signal }));
    } catch (error) {
      if (error instanceof Error) {
        searchError = error.message;
        session.render();
      }
      return;
    }
    void fetched
      .then(results => {
        if (local.signal.aborted) {
          return;
        }
        active = undefined;
        searchError = undefined;
        searchResults = normalizeChoices(results ?? []);
        status = 'idle';
        session.setLoading(false);
        session.render();
      })
      .catch(error => {
        if (local.signal.aborted) {
          return;
        }
        if (error instanceof Error) {
          searchError = error.message;
          session.render();
        }
      });
  };

  session = new PromptSession<Value>({
    context,
    clearPromptOnDone: context?.clearPromptOnDone,
    view: () => {
      const message = session.palette.bold(config.message);
      const choice = selectedChoice();
      const bounds = findBounds(searchResults);

      if (status === 'done' && choice) {
        return [session.prefix('done'), message, session.palette.cyan(choice.short)]
          .filter(Boolean)
          .join(' ')
          .trimEnd();
      }

      const header = [session.prefix(status === 'done' ? 'done' : 'idle'), message, session.palette.cyan(searchTerm)]
        .filter(Boolean)
        .join(' ')
        .trimEnd();

      let error: string | undefined;
      if (searchError) {
        error = session.palette.red(`> ${searchError}`);
      } else if (searchResults.length === 0 && searchTerm !== '' && status === 'idle') {
        error = session.palette.red('> No results found');
      }

      const activeIndex = active === undefined ? bounds.first : active;
      const page =
        searchResults.length === 0
          ? ''
          : paginator.page(
              searchResults,
              activeIndex >= 0 ? activeIndex : 0,
              (item, isActive) => {
                if (!item) {
                  return '';
                }
                if (item.disabled !== false) {
                  const label = typeof item.disabled === 'string' ? item.disabled : '(disabled)';
                  return session.palette.dim(`- ${item.name} ${label}`);
                }
                const row = `${isActive ? figures.pointer : ' '} ${item.name}`;
                return isActive ? session.palette.cyan(row) : row;
              },
              session.pageWidth,
            );

      const body = [
        error ?? page,
        ' ',
        choice?.description ? session.palette.cyan(choice.description) : '',
        helpLine(session.palette),
      ]
        .filter(Boolean)
        .join('\n')
        .trimEnd();

      return [header, body];
    },
    onKey: async key => {
      if (isEnterKey(key)) {
        const choice = selectedChoice();
        if (!choice) {
          session.rl.write(searchTerm);
          return;
        }

        status = 'loading';
        session.setLoading(true);
        session.render();
        let valid: boolean | string;
        try {
          valid = await validate(choice.value);
        } catch (error) {
          session.fail(error);
          return;
        }
        if (session.isSettled) {
          return;
        }

        session.setLoading(false);
        status = 'idle';

        // A pending source can resolve while validate() is awaited. Select
        // whatever is highlighted now so the value matches the final line.
        const confirmed = selectedChoice() ?? choice;
        if (valid === true) {
          status = 'done';
          session.finish(confirmed.value);
        } else if (confirmed.name === searchTerm) {
          searchError = valid || 'You must provide a valid value';
          session.render();
        } else {
          session.rl.write(confirmed.name);
          searchTerm = confirmed.name;
          loadResults(confirmed.name);
        }
        return;
      }

      if (isTabKey(key) && selectedChoice()) {
        const choice = selectedChoice() as NormalizedChoice<Value>;
        session.rl.clearLine(0);
        session.rl.write(choice.name);
        searchTerm = choice.name;
        loadResults(choice.name);
        return;
      }

      if (status !== 'loading' && (isUpKey(key) || isDownKey(key))) {
        session.rl.clearLine(0);
        const bounds = findBounds(searchResults);
        const current = active === undefined ? bounds.first : active;
        if (current < 0) {
          return;
        }
        if (
          (isUpKey(key) && current !== bounds.first) ||
          (isDownKey(key) && current !== bounds.last)
        ) {
          const next = moveActive(searchResults, current, isUpKey(key) ? -1 : 1);
          if (next !== current) {
            active = next;
            session.render();
          }
        }
        return;
      }

      if (status === 'done') {
        return;
      }

      if (searchTerm !== session.rl.line) {
        searchTerm = session.rl.line;
        loadResults(searchTerm);
      }
    },
    onStart: () => loadResults(''),
  });

  session.onCleanup(() => controller?.abort());
  session.setLoading(true);
  session.start();
  return session.promise;
}

/* -------------------------------------------------------------------------- */
/* prompt() compatibility helper                                              */
/* -------------------------------------------------------------------------- */

export type PromptQuestion =
  | ({ type?: 'input'; name: string } & InputConfig)
  | ({ type: 'confirm'; name: string } & ConfirmConfig)
  | ({ type: 'select' | 'list'; name: string } & SelectConfig<unknown>)
  | ({ type: 'search'; name: string } & SearchConfig<unknown>);

/**
 * Inquirer-compatible `inquirer.prompt(questions)` for the four prompt types
 * above. Answers are returned as a plain object keyed by `name`.
 */
export async function prompt<T = Record<string, unknown>>(
  questions: PromptQuestion | readonly PromptQuestion[],
  context?: PromptContext,
): Promise<T> {
  const list = Array.isArray(questions) ? questions : [questions as PromptQuestion];
  const answers: Record<string, unknown> = {};

  for (const question of list) {
    switch (question.type ?? 'input') {
      case 'input':
        answers[question.name] = await input(question, context);
        break;
      case 'confirm':
        answers[question.name] = await confirm(question, context);
        break;
      case 'select':
      case 'list':
        answers[question.name] = await select(question, context);
        break;
      case 'search':
        answers[question.name] = await search(question, context);
        break;
      default:
        throw new ValidationError(`[prompt] Unsupported question type: ${String((question as { type?: unknown }).type)}`);
    }
  }

  return answers as T;
}
