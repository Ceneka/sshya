/**
 * 01 — Fixed context cost.
 *
 * Starts the real MCP server in-process (createMcpServer + InMemoryTransport),
 * performs the handshake a client performs on startup, and measures exactly what
 * an agent pays before it runs a single command:
 *
 *   - initialize.instructions (always injected)
 *   - tools/list: every tool description + input schema (always injected)
 *   - resources/list (names only; cheap)
 *   - sshya://guide (read on demand)
 *
 * Run: bun run bench/01-fixed-cost.ts
 */
import fs from 'fs';
import {
  createBenchEnv,
  seedConnections,
  startBenchClient,
  writeResults,
  type BenchClient,
} from './lib/harness';
import { fmt, pct, sizeOf, tokens, TOKENIZER_NAME } from './lib/tokenizer';

interface ToolRow {
  name: string;
  titleChars: number;
  descriptionChars: number;
  descriptionTokens: number;
  schemaChars: number;
  schemaTokens: number;
  totalChars: number;
  totalTokens: number;
  paramCount: number;
  paramDescriptionTokens: number;
}

const sentenceSplit = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0);

const shingles = (text: string, size: number): string[] => {
  const words = text.toLowerCase().replace(/[^a-z0-9_]+/g, ' ').split(/\s+/).filter(Boolean);
  const result: string[] = [];
  for (let index = 0; index + size <= words.length; index += 1) {
    result.push(words.slice(index, index + size).join(' '));
  }
  return result;
};

/** Drop `title`, keep the first sentence, cap parameter descriptions. */
const projectSlimTools = (tools: any[], paramCap = 40): any[] => {
  return tools.map(tool => {
    const clone = structuredClone(tool);
    delete clone.title;
    if (typeof clone.description === 'string') {
      clone.description = sentenceSplit(clone.description)[0] ?? clone.description;
    }
    const walk = (schema: any) => {
      if (!schema || typeof schema !== 'object') return;
      if (typeof schema.description === 'string') {
        if (schema.description.length > paramCap) {
          const cut = schema.description.slice(0, paramCap);
          const lastSpace = cut.lastIndexOf(' ');
          schema.description = `${cut.slice(0, lastSpace > 20 ? lastSpace : paramCap)}…`;
        }
      }
      for (const key of ['properties', 'items', '$defs', 'definitions']) {
        if (schema[key]) {
          for (const child of Object.values(schema[key])) walk(child);
        }
      }
      if (Array.isArray(schema.anyOf)) schema.anyOf.forEach(walk);
      if (Array.isArray(schema.oneOf)) schema.oneOf.forEach(walk);
      if (Array.isArray(schema.allOf)) schema.allOf.forEach(walk);
    };
    walk(clone.inputSchema);
    return clone;
  });
};

const collectText = (tools: any[], instructions: string, guide: string): string[] => {
  const pieces: string[] = [instructions, guide];
  for (const tool of tools) {
    pieces.push(typeof tool.description === 'string' ? tool.description : '');
    const walk = (schema: any) => {
      if (!schema || typeof schema !== 'object') return;
      if (typeof schema.description === 'string') pieces.push(schema.description);
      for (const key of ['properties', 'items', '$defs', 'definitions']) {
        if (schema[key]) for (const child of Object.values(schema[key])) walk(child);
      }
      if (Array.isArray(schema.anyOf)) schema.anyOf.forEach(walk);
      if (Array.isArray(schema.oneOf)) schema.oneOf.forEach(walk);
    };
    walk(tool.inputSchema);
  }
  return pieces.filter(Boolean);
};

const measureDuplicateSentences = (pieces: string[]) => {
  const counts = new Map<string, number>();
  const tokensBySentence = new Map<string, number>();
  for (const piece of pieces) {
    for (const sentence of sentenceSplit(piece)) {
      if (sentence.length < 24) continue;
      const key = sentence.toLowerCase().replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
      counts.set(key, (counts.get(key) ?? 0) + 1);
      tokensBySentence.set(key, tokens(sentence));
    }
  }
  const repeated = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([sentence, count]) => ({
      sentence,
      count,
      wastedTokens: (count - 1) * (tokensBySentence.get(sentence) ?? 0),
    }))
    .sort((a, b) => b.wastedTokens - a.wastedTokens);
  return {
    repeatedSentences: repeated,
    wastedTokens: repeated.reduce((sum, row) => sum + row.wastedTokens, 0),
  };
};

const measureDuplicateShingles = (pieces: string[], size = 10) => {
  const counts = new Map<string, number>();
  for (const piece of pieces) {
    for (const shingle of new Set(shingles(piece, size))) {
      counts.set(shingle, (counts.get(shingle) ?? 0) + 1);
    }
  }
  const repeated = [...counts.entries()].filter(([, count]) => count > 1);
  // Each repeated shingle beyond its first owner is one duplicated `size`-word run.
  const duplicatedRuns = repeated.reduce((sum, [, count]) => sum + (count - 1), 0);
  return { shingleSize: size, repeatedShingles: repeated.length, duplicatedRuns };
};

const main = async () => {
  const paths = createBenchEnv('sshya-bench-fixed');
  seedConnections(paths.db, { count: 5 });

  const bench: BenchClient = await startBenchClient(paths);

  const serverVersion = bench.client.getServerVersion();
  const capabilities = bench.client.getServerCapabilities();
  const instructions = bench.client.getInstructions() ?? '';

  const toolsStart = bench.wire.length;
  const toolsResponse = await bench.client.listTools();
  const toolsWire = bench.wire.slice(toolsStart).filter(entry => entry.direction === 'server->client');
  const toolsWireChars = toolsWire.reduce((sum, entry) => sum + entry.bytes, 0);

  const resourcesStart = bench.wire.length;
  const resourcesResponse = await bench.client.listResources();
  const resourcesWire = bench.wire.slice(resourcesStart).filter(entry => entry.direction === 'server->client');
  const resourcesWireChars = resourcesWire.reduce((sum, entry) => sum + entry.bytes, 0);

  const guideStart = bench.wire.length;
  const guideResponse = await bench.client.readResource({ uri: 'sshya://guide' });
  const guideWire = bench.wire.slice(guideStart).filter(entry => entry.direction === 'server->client');
  const guideWireChars = guideWire.reduce((sum, entry) => sum + entry.bytes, 0);
  const guideText = (guideResponse.contents[0] as { text?: string } | undefined)?.text ?? '';

  const tools = toolsResponse.tools as any[];

  const rows: ToolRow[] = tools.map(tool => {
    const title = typeof tool.title === 'string' ? tool.title : '';
    const description = typeof tool.description === 'string' ? tool.description : '';
    const schemaText = JSON.stringify(tool.inputSchema ?? {});
    const paramDescriptions: string[] = [];
    const walk = (schema: any) => {
      if (!schema || typeof schema !== 'object') return;
      if (typeof schema.description === 'string') paramDescriptions.push(schema.description);
      for (const key of ['properties', 'items', '$defs', 'definitions']) {
        if (schema[key]) for (const child of Object.values(schema[key])) walk(child);
      }
      if (Array.isArray(schema.anyOf)) schema.anyOf.forEach(walk);
      if (Array.isArray(schema.oneOf)) schema.oneOf.forEach(walk);
    };
    walk(tool.inputSchema);
    const totalText = JSON.stringify(tool);
    return {
      name: tool.name,
      titleChars: title.length,
      descriptionChars: description.length,
      descriptionTokens: tokens(description),
      schemaChars: schemaText.length,
      schemaTokens: tokens(schemaText),
      totalChars: totalText.length,
      totalTokens: tokens(totalText),
      paramCount: Object.keys(tool.inputSchema?.properties ?? {}).length,
      paramDescriptionTokens: tokens(paramDescriptions.join(' ')),
    };
  }).sort((a, b) => b.totalTokens - a.totalTokens);

  const toolListText = JSON.stringify({ tools });
  const slimTools = projectSlimTools(tools);
  const slimText = JSON.stringify({ tools: slimTools });
  const slimCap60 = JSON.stringify({ tools: projectSlimTools(tools, 60) });

  // Aggressive variant: no parameter descriptions at all (rely on names + guide).
  const leanTools = projectSlimTools(tools, 0).map((tool: any) => {
    const walk = (schema: any) => {
      if (!schema || typeof schema !== 'object') return;
      delete schema.description;
      for (const key of ['properties', 'items', '$defs', 'definitions']) {
        if (schema[key]) for (const child of Object.values(schema[key])) walk(child);
      }
      if (Array.isArray(schema.anyOf)) schema.anyOf.forEach(walk);
      if (Array.isArray(schema.oneOf)) schema.oneOf.forEach(walk);
      if (Array.isArray(schema.allOf)) schema.allOf.forEach(walk);
    };
    walk(tool.inputSchema);
    return tool;
  });
  const leanText = JSON.stringify({ tools: leanTools });

  // Boilerplate the SDK emits per tool. These are cheap individually but
  // repeated 12 times; quantify them so a recommendation can be precise.
  const boilerplate = {
    titles: tools.reduce((sum, tool) => sum + tokens(typeof tool.title === 'string' ? tool.title : ''), 0),
    schemaDialect: {
      occurrences: tools.filter(tool => tool.inputSchema?.$schema).length,
      tokens: tools.reduce((sum, tool) => sum + tokens(JSON.stringify(tool.inputSchema?.$schema ?? '')), 0),
    },
    executionTaskSupport: {
      occurrences: tools.filter(tool => tool.execution).length,
      tokens: tools.reduce((sum, tool) => sum + tokens(JSON.stringify(tool.execution ?? {})), 0),
    },
    safeIntegerMaximums: {
      occurrences: JSON.stringify({ tools }).split('9007199254740991').length - 1,
      tokens: (JSON.stringify({ tools }).split('9007199254740991').length - 1) * tokens('9007199254740991'),
    },
    annotations: {
      occurrences: tools.filter(tool => tool.annotations).length,
      tokens: tools.reduce((sum, tool) => sum + tokens(JSON.stringify(tool.annotations ?? {})), 0),
    },
    parameterDescriptions: {
      tokens: rows.reduce((sum, row) => sum + row.paramDescriptionTokens, 0),
    },
    descriptionTokens: rows.reduce((sum, row) => sum + row.descriptionTokens, 0),
    schemaTokens: rows.reduce((sum, row) => sum + row.schemaTokens, 0),
  };

  const resourceListText = JSON.stringify({ resources: resourcesResponse.resources });
  const guideWrapperText = JSON.stringify({ contents: guideResponse.contents });

  const duplicateSentences = measureDuplicateSentences(collectText(tools, instructions, guideText));
  const duplicateShingles = measureDuplicateShingles(collectText(tools, instructions, guideText));

  const totalAlways = instructions + toolListText;
  const totalWithGuide = totalAlways + guideText;

  // Raw protocol envelope cost, for reference only (not billed to the model).
  const initWire = bench.wire.find(
    entry => entry.direction === 'server->client'
      && (entry.message as any)?.result?.serverInfo !== undefined,
  );

  // Parameter-description repetition across tools.
  const paramDescCounts = new Map<string, number>();
  for (const tool of tools) {
    const walk = (schema: any) => {
      if (!schema || typeof schema !== 'object') return;
      if (typeof schema.description === 'string' && schema.description.length > 0) {
        paramDescCounts.set(schema.description, (paramDescCounts.get(schema.description) ?? 0) + 1);
      }
      for (const key of ['properties', 'items', '$defs', 'definitions']) {
        if (schema[key]) for (const child of Object.values(schema[key])) walk(child);
      }
      if (Array.isArray(schema.anyOf)) schema.anyOf.forEach(walk);
      if (Array.isArray(schema.oneOf)) schema.oneOf.forEach(walk);
    };
    walk(tool.inputSchema);
  }
  const repeatedParamDescriptions = [...paramDescCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([description, count]) => ({ description, count, tokensEach: tokens(description), wastedTokens: (count - 1) * tokens(description) }))
    .sort((a, b) => b.wastedTokens - a.wastedTokens);

  const result = {
    tokenizer: TOKENIZER_NAME,
    server: serverVersion,
    capabilities,
    toolCount: tools.length,
    instructions: { ...sizeOf(instructions), text: instructions },
    toolsList: {
      ...sizeOf(toolListText),
      rawWireChars: toolsWireChars,
      rows,
    },
    resourcesList: { ...sizeOf(resourceListText), rawWireChars: resourcesWireChars, resources: resourcesResponse.resources },
    guide: { ...sizeOf(guideText), wrappedChars: guideWrapperText.length, rawWireChars: guideWireChars },
    alwaysOn: {
      chars: totalAlways.length,
      tokens: tokens(totalAlways),
      approxTokens: Math.ceil(totalAlways.length / 4),
    },
    withGuide: {
      chars: totalWithGuide.length,
      tokens: tokens(totalWithGuide),
      approxTokens: Math.ceil(totalWithGuide.length / 4),
    },
    protocolEnvelope: {
      initializeResponseChars: initWire?.bytes ?? null,
    },
    redundancy: {
      ...duplicateSentences,
      ...duplicateShingles,
      repeatedParamDescriptions,
      boilerplate,
    },
    projection: {
      note: 'Historical round-1 projection: tools/list JSON transformed in memory. Kept for the before/after narrative; the shipped descriptions are the current measurement above.',
      currentToolsList: { chars: toolListText.length, tokens: tokens(toolListText) },
      slim40: { chars: slimText.length, tokens: tokens(slimText) },
      slim60: { chars: slimCap60.length, tokens: tokens(slimCap60) },
      leanNoParamDescriptions: { chars: leanText.length, tokens: tokens(leanText) },
      instructionAndToolTotalCurrent: tokens(instructions + toolListText),
      instructionAndToolTotalSlim40: tokens(instructions + slimText),
      instructionAndToolTotalLean: tokens(instructions + leanText),
      savingsTokens: tokens(instructions + toolListText) - tokens(instructions + slimText),
      leanSavingsTokens: tokens(instructions + toolListText) - tokens(instructions + leanText),
    },
  };

  const file = writeResults('fixed-cost.json', result);

  console.log(`tokenizer: ${TOKENIZER_NAME}`);
  console.log(`server: ${serverVersion?.name} ${serverVersion?.version}, tools: ${tools.length}\n`);
  console.log('FIXED CONTEXT (what an agent pays before the first command)');
  console.log('component'.padEnd(34) + 'chars'.padStart(9) + 'tokens'.padStart(9) + 'chars/4'.padStart(10));
  for (const [label, text] of [
    ['initialize.instructions', instructions],
    ['tools/list (definitions)', toolListText],
    ['resources/list (names)', resourceListText],
    ['sshya://guide (on demand)', guideText],
  ] as const) {
    const size = sizeOf(text);
    console.log(label.padEnd(34) + fmt(size.chars).padStart(9) + fmt(size.tokens).padStart(9) + fmt(size.approxTokens).padStart(10));
  }
  console.log('always-on (instructions + tools)'.padEnd(34) + fmt(totalAlways.length).padStart(9) + fmt(tokens(totalAlways)).padStart(9) + fmt(Math.ceil(totalAlways.length / 4)).padStart(10));
  console.log('with guide'.padEnd(34) + fmt(totalWithGuide.length).padStart(9) + fmt(tokens(totalWithGuide)).padStart(9) + fmt(Math.ceil(totalWithGuide.length / 4)).padStart(10));

  console.log('\nPER-TOOL COST (sorted by total tokens)');
  console.log('tool'.padEnd(20) + 'desc tok'.padStart(9) + 'schema tok'.padStart(11) + 'total tok'.padStart(10) + 'params'.padStart(8) + 'param desc tok'.padStart(15));
  for (const row of rows) {
    console.log(
      row.name.padEnd(20)
      + fmt(row.descriptionTokens).padStart(9)
      + fmt(row.schemaTokens).padStart(11)
      + fmt(row.totalTokens).padStart(10)
      + String(row.paramCount).padStart(8)
      + fmt(row.paramDescriptionTokens).padStart(15),
    );
  }

  console.log('\nREDUNDANCY');
  console.log(`exact repeated sentences: ${duplicateSentences.repeatedSentences.length}, wasted ~${fmt(duplicateSentences.wastedTokens)} tok`);
  for (const row of duplicateSentences.repeatedSentences.slice(0, 6)) {
    console.log(`  x${row.count} (${row.wastedTokens} tok wasted): ${row.sentence.slice(0, 110)}`);
  }
  console.log(`repeated ${duplicateShingles.shingleSize}-word shingles: ${duplicateShingles.repeatedShingles}, duplicated runs ~${duplicateShingles.duplicatedRuns}`);
  console.log('repeated parameter descriptions:');
  for (const row of repeatedParamDescriptions.slice(0, 8)) {
    console.log(`  x${row.count} (${row.wastedTokens} tok wasted): ${row.description.slice(0, 90)}`);
  }
  console.log('boilerplate (per tools/list):');
  console.log(`  titles ${fmt(boilerplate.titles)} tok; $schema ${boilerplate.schemaDialect.occurrences}x ${fmt(boilerplate.schemaDialect.tokens)} tok; execution ${boilerplate.executionTaskSupport.occurrences}x ${fmt(boilerplate.executionTaskSupport.tokens)} tok; MAX_SAFE_INTEGER ${boilerplate.safeIntegerMaximums.occurrences}x ${fmt(boilerplate.safeIntegerMaximums.tokens)} tok; annotations ${fmt(boilerplate.annotations.tokens)} tok`);
  console.log(`  descriptions ${fmt(boilerplate.descriptionTokens)} tok; schemas ${fmt(boilerplate.schemaTokens)} tok (of which param descriptions ${fmt(boilerplate.parameterDescriptions.tokens)} tok)`);

  console.log('\nPROJECTION (historical, round 1; no product change)');
  console.log(`current tools/list: ${fmt(result.projection.currentToolsList.tokens)} tok; slim (first sentence, no titles, 40-char params): ${fmt(result.projection.slim40.tokens)} tok (${pct(result.projection.savingsTokens, result.projection.instructionAndToolTotalCurrent)} of always-on)`);
  console.log(`lean (no param descriptions at all): ${fmt(result.projection.leanNoParamDescriptions.tokens)} tok (${pct(result.projection.leanSavingsTokens, result.projection.instructionAndToolTotalCurrent)} of always-on)`);
  console.log(`\nwrote ${file}`);

  await bench.close();
  fs.rmSync(paths.root, { recursive: true, force: true });
};

await main();
