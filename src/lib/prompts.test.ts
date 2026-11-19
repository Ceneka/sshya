import { describe, expect, test } from 'bun:test';
import confirmPrompt from '@inquirer/confirm';
import inputPrompt from '@inquirer/input';
import searchPrompt from '@inquirer/search';
import selectPrompt from '@inquirer/select';
import { PassThrough, Writable } from 'node:stream';
import {
  AbortPromptError,
  ExitPromptError,
  ValidationError,
  confirm,
  input,
  prompt,
  search,
  select,
  type PromptContext,
} from './prompts';

/* -------------------------------------------------------------------------- */
/* Fake TTY streams                                                           */
/* -------------------------------------------------------------------------- */

class FakeInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  rawModeChanges: boolean[] = [];

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
    this.rawModeChanges.push(mode);
  }
}

class FakeOutput extends Writable {
  isTTY = true;
  columns = 100;
  rows = 40;
  data = '';

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.data += chunk.toString();
    callback();
  }
}

interface RunResult<T> {
  answer: T | undefined;
  error: unknown;
  output: string;
  screen: string[];
  input: FakeInput;
  rawModes: boolean[];
}

interface RunOptions {
  color?: boolean;
  keyDelay?: number | readonly number[];
  settleDelay?: number;
}

type AnyPromptFn = (config: never, context: PromptContext) => Promise<unknown>;

const delay = async (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`prompt did not settle within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

/**
 * Drive a prompt with keystrokes, exactly like a user at a terminal.
 * `answer` is left undefined when the prompt rejects.
 */
const runPrompt = async <T>(
  fn: AnyPromptFn,
  config: unknown,
  keys: readonly string[],
  options: RunOptions = {},
): Promise<RunResult<T>> => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const context: PromptContext = {
    input,
    output,
    ...(options.color !== undefined ? { color: options.color } : {}),
  };

  const promise = (fn as unknown as (c: unknown, ctx: PromptContext) => Promise<T>)(config, context);
  const observed = promise.then(
    value => ({ value }),
    (reason: unknown) => ({ error: reason }),
  );
  const keyDelay = options.keyDelay ?? 25;

  for (const [index, key] of keys.entries()) {
    await delay(typeof keyDelay === 'number' ? keyDelay : (keyDelay[index] ?? 25));
    input.write(key);
  }

  let answer: T | undefined;
  let error: unknown;
  try {
    const outcome = await withTimeout(observed, 2_500);
    if ('error' in outcome) {
      error = outcome.error;
    } else {
      answer = outcome.value;
    }
  } catch (caught) {
    error = caught;
  }

  await delay(options.settleDelay ?? 20);
  const screen = renderScreen(output.data);
  return { answer, error, output: output.data, screen, input, rawModes: input.rawModeChanges };
};

/**
 * Same as runPrompt, but captures the visible screen after every keystroke.
 * Used to compare inquirer's pagination window frame by frame.
 */
const runPromptFrames = async (
  fn: AnyPromptFn,
  config: unknown,
  keys: readonly string[],
  options: RunOptions = {},
): Promise<string[][]> => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const context: PromptContext = { input, output };
  const promise = (fn as unknown as (c: unknown, ctx: PromptContext) => Promise<unknown>)(config, context);
  const observed = promise.then(
    () => undefined,
    () => undefined,
  );
  const keyDelay = options.keyDelay ?? 25;
  const frames: string[][] = [];

  for (const [index, key] of keys.entries()) {
    const wait = typeof keyDelay === 'number' ? keyDelay : (keyDelay[index] ?? 25);
    await delay(wait);
    input.write(key);
    await delay(wait);
    frames.push(renderScreen(output.data));
  }

  await withTimeout(observed, 2_500).catch(() => undefined);
  return frames;
};

/* -------------------------------------------------------------------------- */
/* Tiny ANSI terminal emulator                                                */
/* -------------------------------------------------------------------------- */

/**
 * Replays cursor movements, line erases and text into a 100x40 grid so tests
 * can compare the visible screen (not just raw control sequences) with the
 * real @inquirer packages.
 */
const renderScreen = (output: string): string[] => {
  const cols = 100;
  const grid: string[][] = Array.from({ length: 40 }, () => Array<string>(cols).fill(' '));
  let row = 0;
  let col = 0;

  const ensureRow = (): void => {
    while (row >= grid.length) {
      grid.push(Array<string>(cols).fill(' '));
    }
  };

  const put = (character: string): void => {
    if (col >= cols) {
      col = 0;
      row += 1;
    }
    ensureRow();
    const line = grid[row];
    if (line) {
      line[col] = character;
    }
    col += 1;
  };

  let index = 0;
  while (index < output.length) {
    const character = output[index] ?? '';
    if (character === '\u001B') {
      const match = /^\u001B\[([0-9;?]*)([A-Za-z])/.exec(output.slice(index));
      if (match) {
        const params = (match[1] ?? '').split(';').filter(part => part !== '').map(Number);
        const amount = params[0] || 1;
        const command = match[2];
        const current = grid[row];
        if (command === 'A') {
          row = Math.max(0, row - amount);
        } else if (command === 'B') {
          row += amount;
          ensureRow();
        } else if (command === 'C') {
          col = Math.min(cols - 1, col + amount);
        } else if (command === 'D') {
          col = Math.max(0, col - amount);
        } else if (command === 'G') {
          col = Math.min(cols - 1, (params[0] || 1) - 1);
        } else if (command === 'H') {
          row = (params[0] || 1) - 1;
          col = (params[1] || 1) - 1;
        } else if (command === 'K') {
          if (current) {
            if ((match[1] ?? '').includes('2')) {
              current.fill(' ');
            } else {
              current.fill(' ', col);
            }
          }
        }
        index += match[0].length;
        continue;
      }
      index += 1;
      continue;
    }

    if (character === '\n') {
      row += 1;
      col = 0;
      ensureRow();
      index += 1;
      continue;
    }
    if (character === '\r') {
      col = 0;
      index += 1;
      continue;
    }
    if (character === '\b') {
      col = Math.max(0, col - 1);
      index += 1;
      continue;
    }

    put(character);
    index += 1;
  }

  const lines = grid.map(line => line.join('').replace(/\s+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
};

const finalLine = (screen: readonly string[]): string => screen[screen.length - 1] ?? '';

/* -------------------------------------------------------------------------- */
/* input                                                                      */
/* -------------------------------------------------------------------------- */

describe('input', () => {
  test('accepts the default on Enter and renders the inquirer final line', async () => {
    const config = { message: 'Alias:', default: 'bob' };
    const ours = await runPrompt<string>(input as AnyPromptFn, config, ['\r']);
    const reference = await runPrompt<string>(inputPrompt as AnyPromptFn, config, ['\r']);

    expect(ours.answer).toBe('bob');
    expect(ours.screen).toEqual(reference.screen);
    expect(finalLine(ours.screen)).toBe('✔ Alias: bob');
    expect(ours.input.isRaw).toBe(false);
  });

  test('types, edits with arrow keys, and matches every inquirer frame', async () => {
    const config = { message: 'Alias:', default: 'bob' };
    const keys = ['x', '\u001B[D', 'y', '\u001B[3~', '\r'];
    const ours = await runPrompt<string>(input as AnyPromptFn, config, keys);
    const reference = await runPrompt<string>(inputPrompt as AnyPromptFn, config, keys);

    expect(ours.answer).toBe('y');
    expect(ours.screen).toEqual(reference.screen);
    expect(finalLine(ours.screen)).toBe('✔ Alias: y');
  });

  test('shows validation errors and keeps the value editable', async () => {
    const config = {
      message: 'Alias:',
      default: 'bob',
      validate: (value: string) => (value === 'bad' ? 'nope' : true),
    };
    const keys = ['b', 'a', 'd', '\r', '\u007F', '\u007F', '\u007F', '\r'];
    const ours = await runPrompt<string>(input as AnyPromptFn, config, keys);
    const reference = await runPrompt<string>(inputPrompt as AnyPromptFn, config, keys);

    expect(ours.answer).toBe('bob');
    expect(ours.screen).toEqual(reference.screen);
    expect(ours.output).toContain('> nope');
  });

  test('backspace clears the default hint; Tab fills it', async () => {
    const config = { message: 'Port (optional):', default: '22' };

    const erased = await runPrompt<string>(input as AnyPromptFn, config, ['\u007F', '\r']);
    const erasedReference = await runPrompt<string>(inputPrompt as AnyPromptFn, config, ['\u007F', '\r']);
    expect(erased.answer).toBe('');
    expect(erased.screen).toEqual(erasedReference.screen);

    const filled = await runPrompt<string>(input as AnyPromptFn, config, ['\t', '\r']);
    const filledReference = await runPrompt<string>(inputPrompt as AnyPromptFn, config, ['\t', '\r']);
    expect(filled.answer).toBe('22');
    expect(filled.screen).toEqual(filledReference.screen);
  });

  test('uses the exact inquirer ANSI styling', async () => {
    const result = await runPrompt<string>(
      input as AnyPromptFn,
      { message: 'Alias:', default: 'bob' },
      ['h', 'i', '\r'],
      { color: true },
    );

    expect(result.output).toContain('\u001B[34m?\u001B[39m');
    expect(result.output).toContain('\u001B[1mAlias:\u001B[22m');
    expect(result.output).toContain('\u001B[2m(bob)\u001B[22m');
    expect(result.output).toContain('\u001B[32m✔\u001B[39m');
    expect(result.output).toContain('\u001B[36mhi\u001B[39m');
  });
});

/* -------------------------------------------------------------------------- */
/* confirm                                                                    */
/* -------------------------------------------------------------------------- */

describe('confirm', () => {
  test('Enter accepts Yes by default', async () => {
    const config = { message: 'Do you want to test the new connection now?', default: true };
    const ours = await runPrompt<boolean>(confirm as AnyPromptFn, config, ['\r']);
    const reference = await runPrompt<boolean>(confirmPrompt as AnyPromptFn, config, ['\r']);

    expect(ours.answer).toBe(true);
    expect(ours.screen).toEqual(reference.screen);
    expect(finalLine(ours.screen)).toBe('✔ Do you want to test the new connection now? Yes');
  });

  test('typed y/n, garbage, Tab toggle, and default false match inquirer', async () => {
    const cases: Array<{ config: { message: string; default?: boolean }; keys: string[]; answer: boolean }> = [
      { config: { message: 'Ok?', default: true }, keys: ['n', '\r'], answer: false },
      { config: { message: 'Ok?', default: false }, keys: ['y', '\r'], answer: true },
      { config: { message: 'Ok?', default: true }, keys: ['f', 'o', 'o', '\r'], answer: true },
      { config: { message: 'Ok?', default: false }, keys: ['\r'], answer: false },
      { config: { message: 'Ok?', default: true }, keys: ['\t', '\r'], answer: false },
    ];

    for (const item of cases) {
      const ours = await runPrompt<boolean>(confirm as AnyPromptFn, item.config, item.keys);
      const reference = await runPrompt<boolean>(confirmPrompt as AnyPromptFn, item.config, item.keys);
      expect(ours.answer).toBe(item.answer);
      expect(ours.screen).toEqual(reference.screen);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* select                                                                     */
/* -------------------------------------------------------------------------- */

describe('select', () => {
  test('returns the first choice, supports arrows and type-to-filter', async () => {
    const config = { message: 'Pick one', choices: ['Skip', 'Overwrite'] };

    const first = await runPrompt<string>(select as AnyPromptFn, config, ['\r']);
    const firstReference = await runPrompt<string>(selectPrompt as AnyPromptFn, config, ['\r']);
    expect(first.answer).toBe('Skip');
    expect(first.screen).toEqual(firstReference.screen);

    const down = await runPrompt<string>(select as AnyPromptFn, config, ['\u001B[B', '\r']);
    const downReference = await runPrompt<string>(selectPrompt as AnyPromptFn, config, ['\u001B[B', '\r']);
    expect(down.answer).toBe('Overwrite');
    expect(down.screen).toEqual(downReference.screen);

    const typed = await runPrompt<string>(select as AnyPromptFn, config, ['o', '\r']);
    const typedReference = await runPrompt<string>(selectPrompt as AnyPromptFn, config, ['o', '\r']);
    expect(typed.answer).toBe('Overwrite');
    expect(typed.screen).toEqual(typedReference.screen);
    expect(finalLine(typed.screen)).toBe('✔ Pick one Overwrite');
  });

  test('renders value objects, short names, descriptions and defaults', async () => {
    const choices = [
      { name: 'one', value: 1, short: '1st', description: 'the first one' },
      { name: 'two', value: 2, short: '2nd' },
    ];
    const config = { message: 'Pick', choices, default: 2 };
    const ours = await runPrompt<number>(select as AnyPromptFn, config, ['\r']);
    const reference = await runPrompt<number>(selectPrompt as AnyPromptFn, config, ['\r']);

    expect(ours.answer).toBe(2);
    expect(ours.screen).toEqual(reference.screen);
    expect(finalLine(ours.screen)).toBe('✔ Pick 2nd');
  });

  test('paginates 7 rows with inquirer loop behaviour, matching every frame', async () => {
    const config = {
      message: 'Pick one',
      choices: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
      pageSize: 7,
    };
    const keys = [
      '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B',
      '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B',
      '\u001B[B', '\r',
    ];

    const ours = await runPrompt<string>(select as AnyPromptFn, config, keys, { keyDelay: 20 });
    const reference = await runPrompt<string>(selectPrompt as AnyPromptFn, config, keys, { keyDelay: 20 });
    expect(ours.answer).toBe('a');
    expect(ours.screen).toEqual(reference.screen);

    // Walk the same keys again, checking the visible page after each move.
    const oursFrames = await runPromptFrames(select as AnyPromptFn, config, keys);
    const referenceFrames = await runPromptFrames(selectPrompt as AnyPromptFn, config, keys);
    expect(oursFrames.length).toBe(keys.length);
    for (let index = 0; index < keys.length; index++) {
      expect(oursFrames[index]).toEqual(referenceFrames[index]);
    }

    // The page is always seven rows (a-i), even across the wrap from i to b.
    const firstFrame = oursFrames[0] ?? [];
    expect(firstFrame.filter(line => line.startsWith('❯') || line.startsWith('  '))).toHaveLength(7);
  });

  test('honours loop: false and skips disabled rows', async () => {
    const looped = await runPrompt<string>(
      select as AnyPromptFn,
      { message: 'Pick', choices: ['a', 'b', 'c'], loop: false },
      ['\u001B[A', '\r'],
    );
    const loopedReference = await runPrompt<string>(
      selectPrompt as AnyPromptFn,
      { message: 'Pick', choices: ['a', 'b', 'c'], loop: false },
      ['\u001B[A', '\r'],
    );
    expect(looped.answer).toBe('a');
    expect(looped.screen).toEqual(loopedReference.screen);

    const disabled = await runPrompt<string>(
      select as AnyPromptFn,
      { message: 'Pick', choices: [{ name: 'one', value: 'one', disabled: true }, 'two'] },
      ['\r'],
    );
    const disabledReference = await runPrompt<string>(
      selectPrompt as AnyPromptFn,
      { message: 'Pick', choices: [{ name: 'one', value: 'one', disabled: true }, 'two'] },
      ['\r'],
    );
    expect(disabled.answer).toBe('two');
    expect(disabled.screen).toEqual(disabledReference.screen);
  });

  test('throws ValidationError when every choice is disabled', async () => {
    const result = await runPrompt<string>(
      select as AnyPromptFn,
      { message: 'Pick', choices: [{ name: 'one', value: 'one', disabled: true }] },
      [],
    );
    expect(result.error).toBeInstanceOf(ValidationError);
  });

  test('highlights the active row with the inquirer pointer and color', async () => {
    const result = await runPrompt<string>(
      select as AnyPromptFn,
      { message: 'Pick one', choices: ['Skip', 'Overwrite'] },
      ['\r'],
      { color: true },
    );
    expect(result.output).toContain('\u001B[36m❯ Skip\u001B[39m');
    expect(result.output).toContain('\u001B[?25l');
    expect(result.output).toContain('\u001B[?25h');
  });
});

/* -------------------------------------------------------------------------- */
/* search                                                                     */
/* -------------------------------------------------------------------------- */

describe('search', () => {
  const makeSource = () => {
    const all = [
      { name: 'alpha', value: 'alpha' },
      { name: 'beta', value: 'beta' },
      { name: 'gamma', value: 'gamma' },
    ];
    return async (term: string | undefined): Promise<typeof all> =>
      term ? all.filter(choice => choice.name.includes(term)) : all;
  };

  test('loads initial results, filters as you type and returns the selected value', async () => {
    const config = { message: 'Select a connection', source: makeSource() };
    const keys = ['\r'];
    const ours = await runPrompt<string>(search as AnyPromptFn, config, keys);
    const reference = await runPrompt<string>(searchPrompt as AnyPromptFn, config, keys);

    expect(ours.answer).toBe('alpha');
    expect(ours.screen).toEqual(reference.screen);
    expect(finalLine(ours.screen)).toBe('✔ Select a connection alpha');

    const typedKeys = ['b', '\r'];
    const typed = await runPrompt<string>(search as AnyPromptFn, config, typedKeys);
    const typedReference = await runPrompt<string>(searchPrompt as AnyPromptFn, config, typedKeys);
    expect(typed.answer).toBe('beta');
    expect(typed.screen).toEqual(typedReference.screen);
  });

  test('Tab completes the highlighted row like inquirer', async () => {
    const config = { message: 'Find', source: makeSource() };
    const keys = ['b', '\t', '\r'];
    const ours = await runPrompt<string>(search as AnyPromptFn, config, keys);
    const reference = await runPrompt<string>(searchPrompt as AnyPromptFn, config, keys);

    expect(ours.answer).toBe('beta');
    expect(ours.screen).toEqual(reference.screen);
  });

  test('shows "No results found" and rejects Ctrl+C with ExitPromptError', async () => {
    const config = { message: 'Find', source: makeSource() };
    const result = await runPrompt<string>(search as AnyPromptFn, config, ['z', '\u0003']);

    expect(result.error).toBeInstanceOf(ExitPromptError);
    expect(result.output).toContain('> No results found');
    expect(result.output).toContain('\u001B[?25h');
    expect(result.input.isRaw).toBe(false);
  });

  test('only renders the latest term when async sources resolve out of order', async () => {
    const calls: string[] = [];
    const source = async (term: string | undefined): Promise<Array<{ name: string; value: string }>> => {
      calls.push(term ?? '<initial>');
      if (term === 'a') {
        await delay(120);
        return [{ name: 'stale-a', value: 'stale' }];
      }
      if (term === 'ab') {
        await delay(5);
        return [{ name: 'fresh-ab', value: 'fresh' }];
      }
      return [
        { name: 'alpha', value: 'alpha' },
        { name: 'beta', value: 'beta' },
      ];
    };

    const result = await runPrompt<string>(
      search as AnyPromptFn,
      { message: 'Find', source },
      ['a', 'b', '\r'],
      { keyDelay: [20, 20, 180] },
    );

    expect(result.answer).toBe('fresh');
    expect(calls).toContain('a');
    expect(calls).toContain('ab');
    expect(result.output).not.toContain('stale-a');
    expect(result.output).toContain('fresh-ab');
    expect(result.input.isRaw).toBe(false);
  });

  test('surfaces a source error with inquirer styling', async () => {
    const result = await runPrompt<string>(
      search as AnyPromptFn,
      { message: 'Find', source: async () => { throw new Error('boom'); } },
      ['\u0003'],
    );
    expect(result.error).toBeInstanceOf(ExitPromptError);
    expect(result.output).toContain('> boom');
  });
});

/* -------------------------------------------------------------------------- */
/* prompt() compatibility helper                                              */
/* -------------------------------------------------------------------------- */

describe('prompt', () => {
  test('runs questions in order and returns an answers object', async () => {
    const stdin = new FakeInput();
    const output = new FakeOutput();
    const pending = prompt(
      [
        { type: 'input', name: 'alias', message: 'Alias:', default: 'web' },
        { type: 'input', name: 'user', message: 'User:', default: 'root' },
        { type: 'confirm', name: 'test', message: 'Test now?', default: true },
        { type: 'select', name: 'mode', message: 'Mode', choices: ['Skip', 'Overwrite'] },
      ],
      { input: stdin, output },
    );

    const keys = ['\r', 'd', 'e', 'v', '\r', 'n', '\r', '\u001B[B', '\r'];
    for (const key of keys) {
      await delay(25);
      stdin.write(key);
    }

    const answers = await withTimeout(pending, 2_500);
    expect(answers).toEqual({ alias: 'web', user: 'dev', test: false, mode: 'Overwrite' });
    await delay(20);
    expect(finalLine(renderScreen(output.data))).toBe('✔ Mode Overwrite');
  });

  test('accepts a single question', async () => {
    const stdin = new FakeInput();
    const output = new FakeOutput();
    const pending = prompt({ type: 'confirm', name: 'ok', message: 'Ok?', default: false }, { input: stdin, output });
    await delay(20);
    stdin.write('\r');
    expect(await withTimeout(pending, 2_500)).toEqual({ ok: false });
  });
});

/**
 * Compile-only compatibility check for the question objects used by
 * src/connection/{add,update,import}.ts and src/helpers/selectAlias.ts.
 * Never executed; `bunx tsc --noEmit` keeps the call sites honest.
 */
const callSiteShapes = async (): Promise<void> => {
  const answers = await prompt([
    {
      type: 'input',
      name: 'alias',
      message: 'Alias:',
      default: undefined as string | undefined,
      validate: (candidate: string) => {
        const trimmed = candidate.trim();
        if (!trimmed) {
          return 'Alias cannot be empty';
        }
        return true;
      },
    },
    { type: 'input', name: 'port', message: 'Port (optional):', default: undefined },
    { type: 'confirm', name: 'test', message: 'Do you want to test now?', default: true },
    {
      type: 'select',
      name: 'action',
      message: 'Connection already exists. What do you want to do?',
      choices: ['Skip', 'Overwrite'],
    },
    {
      type: 'search',
      name: 'alias',
      message: 'Select a connection',
      source: async (term: unknown) => [{ name: 'web', value: 'web' }].filter(() => Boolean(term) || true),
    },
  ]);
  const alias = answers.alias as string | undefined;
  void alias;
};

void callSiteShapes;

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

describe('lifecycle', () => {
  test('Ctrl+C rejects with ExitPromptError and restores cursor/raw mode', async () => {
    const result = await runPrompt<string>(input as AnyPromptFn, { message: 'Name:' }, ['\u0003']);

    expect(result.error).toBeInstanceOf(ExitPromptError);
    expect(result.output).toContain('\u001B[?25h');
    expect(result.input.isRaw).toBe(false);
    expect(result.rawModes).toContain(false);
  });

  test('aborting the signal rejects with AbortPromptError', async () => {
    const stdin = new FakeInput();
    const output = new FakeOutput();
    const controller = new AbortController();
    const pending = input({ message: 'Name:' }, { input: stdin, output, signal: controller.signal });
    await delay(20);
    controller.abort();

    let error: unknown;
    try {
      await withTimeout(pending, 1_000);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AbortPromptError);
    await delay(20);
    expect(output.data).toContain('\u001B[?25h');
  });

  test('non-TTY EOF rejects instead of hanging', async () => {
    const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    stdin.isTTY = false;
    const output = new FakeOutput();
    output.isTTY = false;

    const pending = input({ message: 'Name:', default: 'bob' }, { input: stdin, output });
    setTimeout(() => stdin.end(), 20);

    let error: unknown;
    try {
      await withTimeout(pending, 1_000);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ExitPromptError);
  });

  test('non-TTY stdin with piped lines behaves like inquirer', async () => {
    const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    stdin.isTTY = false;
    const output = new FakeOutput();
    output.isTTY = false;

    const pending = input({ message: 'Name:' }, { input: stdin, output });
    stdin.write('piped\r');

    expect(await withTimeout(pending, 1_000)).toBe('piped');
  });
});
