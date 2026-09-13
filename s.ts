#!/usr/bin/env bun

import { connectConnectionPrompt } from './src/connection';
import { initDB } from './src/database';
import { enableEscapeExit } from './src/helpers/escExit';

if (process.stdin.isTTY && process.stdout.isTTY) {
  enableEscapeExit();
}

initDB();

const rawArgs = process.argv.slice(2);
const looksLikeBunShim = rawArgs[0] === 'bun' && rawArgs[1] === 'run';
const userArgs = looksLikeBunShim ? rawArgs.slice(3) : rawArgs;
const arg = userArgs[0];

if (arg === '-h' || arg === '--help') {
  console.log('Usage: s [alias]');
  console.log('Connect to a saved SSH connection. Omit alias to pick interactively.');
  process.exit(0);
}

await connectConnectionPrompt(arg);
