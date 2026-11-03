/**
 * Checks Cairn against the real API, which the local tests cannot do. It spends real money, a
 * few cents at most, so it only runs when asked: ANTHROPIC_API_KEY=... npm run test:live
 *
 * Each check prints what it found, so a failure shows which assumption about the API was wrong.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/core/runtime.ts';
import type { AgentEvent } from '../../src/core/agent.ts';
import type { Prompter } from '../../src/tools/types.ts';

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error('Set ANTHROPIC_API_KEY to run this. It makes a few small real requests.');
  process.exit(2);
}

process.env.CAIRN_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-live-home-')));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-live-')));
const secretWord = `word-${Date.now()}`;
writeFileSync(join(cwd, 'note.txt'), `The secret word is ${secretWord}.\n`);

const prompter: Prompter = {
  permission: async () => ({ behavior: 'deny' }),
  questions: async () => null,
  approvePlan: async () => false,
};

async function turn(runtime: Awaited<ReturnType<typeof createRuntime>>, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runtime.agent.run(prompt, new AbortController().signal)) events.push(event);
  const last = events.at(-1) as Extract<AgentEvent, { type: 'turn_end' }>;
  assert.notEqual(last.stopReason, 'error', last.error);
  return events;
}

const lastText = (events: AgentEvent[]): string => (events.at(-1) as Extract<AgentEvent, { type: 'turn_end' }>).text;
const notices = (events: AgentEvent[]): string[] =>
  events.flatMap((event) => (event.type === 'notice' ? [event.text] : []));

const first = await createRuntime({ cwd, prompter, effort: 'low' });
console.log(`Model: ${first.agent.model}\n`);

console.log('1. Tool round trip, with thinking replayed in the second request');
const toolTurn = await turn(first, 'Use the Read tool on note.txt, then tell me the secret word.');
assert.ok(toolTurn.some((e) => e.type === 'tool_end' && !e.isError), 'the Read tool should have run');
assert.match(lastText(toolTurn), new RegExp(secretWord));
console.log('   ok:', lastText(toolTurn).slice(0, 100));

console.log('2. Prompt caching across requests');
const cacheTurn = await turn(first, 'Reply with the single word: cached');
const reads = first.agent.totalUsage.cacheReadTokens;
console.log(`   ${reads > 0 ? 'ok' : 'NOTE'}: ${reads} tokens read from cache so far`);
console.log('   reply:', lastText(cacheTurn).slice(0, 60));

console.log('3. Resuming sends a history and system prompt the API still accepts');
const sessionId = first.agent.sessionId;
writeFileSync(join(cwd, 'CAIRN.md'), 'This file would change a rebuilt system prompt.');
const resumed = await createRuntime({ cwd, prompter, resume: sessionId, effort: 'low' });
const resumeTurn = await turn(resumed, 'What was the secret word? Reply with just the word.');
assert.match(lastText(resumeTurn), new RegExp(secretWord));
const mismatch = notices(resumeTurn).filter((text) => text.includes('earlier reasoning'));
assert.deepEqual(mismatch, [], 'a clean resume must not invalidate thinking blocks');
console.log('   ok: no thinking blocks were dropped');

console.log('4. Web search as a server tool');
const search = await createRuntime({ cwd, prompter, effort: 'low' });
const searchTurn = await turn(search, 'Use web search once to find the latest Node.js major version. Answer in one short sentence.');
console.log(`   searches: ${search.agent.totalUsage.webSearches}, answer: ${lastText(searchTurn).slice(0, 100)}`);
assert.ok(search.agent.totalUsage.webSearches > 0, 'web search should have been used');

console.log('5. Compaction, then carrying on');
await first.agent.compact('the secret word');
const afterCompact = await turn(first, 'What was the secret word? Reply with just the word.');
assert.match(lastText(afterCompact), new RegExp(secretWord));
console.log('   ok');

const total = first.agent.totalCostUsd + resumed.agent.totalCostUsd + search.agent.totalCostUsd;
console.log(`\nAll checks passed. Estimated spend: $${total.toFixed(4)}`);
