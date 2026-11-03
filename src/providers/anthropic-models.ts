/**
 * What Cairn needs to know per Claude model. Prices are USD per million tokens, taken from
 * platform.claude.com/docs/en/about-claude/pricing on 2026-11-02. Costs built from them are
 * estimates for the user's information and are not a bill.
 */

export interface ModelPrices {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache writes, the only TTL Cairn uses. */
  cacheWrite: number;
}

export interface ModelSpec {
  contextWindow: number;
  maxOutput: number;
  prices: ModelPrices;
  /** Prices for prompts over this many tokens, for models with tiered pricing. */
  longPrompt?: { threshold: number; prices: ModelPrices };
  /** Accepts `thinking: {type: "adaptive"}`. */
  adaptiveThinking: boolean;
  /** Accepts `output_config.effort`. */
  effort: boolean;
  /** Accepts `fallbacks: "default"` on the Claude API. */
  serverFallback: boolean;
  webSearchType: 'web_search_20260209' | 'web_search_20250305';
}

const ONE_MILLION = 1_000_000;
const MAX_OUTPUT = 128_000;

function prices(input: number, cacheWrite: number, cacheRead: number, output: number): ModelPrices {
  return { input, output, cacheRead, cacheWrite };
}

const CURRENT = {
  contextWindow: ONE_MILLION,
  maxOutput: MAX_OUTPUT,
  adaptiveThinking: true,
  effort: true,
  serverFallback: false,
  webSearchType: 'web_search_20260209',
} as const;

const OLDER = {
  contextWindow: 200_000,
  maxOutput: 64_000,
  adaptiveThinking: false,
  effort: false,
  serverFallback: false,
  webSearchType: 'web_search_20250305',
} as const;

const MODELS: Record<string, ModelSpec> = {
  'claude-fable-5-1': { ...CURRENT, prices: prices(10, 12.5, 0.25, 50), serverFallback: true },
  'claude-fable-5': { ...CURRENT, prices: prices(10, 12.5, 1, 50) },
  'claude-opus-5-5': { ...CURRENT, prices: prices(4, 5, 0.2, 20), serverFallback: true },
  'claude-opus-5': { ...CURRENT, prices: prices(5, 6.25, 0.5, 25), serverFallback: true },
  'claude-opus-4-8': { ...CURRENT, prices: prices(5, 6.25, 0.5, 25) },
  'claude-opus-4-7': { ...CURRENT, prices: prices(5, 6.25, 0.5, 25) },
  'claude-opus-4-6': { ...CURRENT, prices: prices(5, 6.25, 0.5, 25) },
  'claude-sonnet-5-5': { ...CURRENT, prices: prices(2, 2.5, 0.1, 10), serverFallback: true },
  'claude-sonnet-5': { ...CURRENT, prices: prices(2, 2.5, 0.2, 10) },
  'claude-sonnet-4-6': { ...CURRENT, prices: prices(3, 3.75, 0.3, 15) },
  'claude-haiku-5-5': {
    ...CURRENT,
    webSearchType: 'web_search_20250305',
    prices: prices(0.1, 0.125, 0.01, 0.5),
    longPrompt: { threshold: 100_000, prices: prices(0.5, 0.625, 0.05, 2.5) },
  },
  'claude-opus-4-5': { ...OLDER, effort: true, prices: prices(5, 6.25, 0.5, 25) },
  'claude-sonnet-4-5': { ...OLDER, prices: prices(3, 3.75, 0.3, 15) },
  'claude-haiku-4-5': { ...OLDER, prices: prices(1, 1.25, 0.1, 5) },
};

export const WEB_SEARCH_USD_EACH = 10 / 1000;

/** The models above, newest lines first, for /model to offer. */
export function knownModelIds(): string[] {
  return Object.keys(MODELS);
}

export function modelSpec(model: string): ModelSpec | undefined {
  return MODELS[model];
}

export interface AttemptUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Returns undefined when any attempt ran on a model with no known price. */
export function estimateCostUsd(attempts: AttemptUsage[], webSearches: number): number | undefined {
  let total = webSearches * WEB_SEARCH_USD_EACH;
  for (const attempt of attempts) {
    const spec = modelSpec(attempt.model);
    if (!spec) return undefined;
    const promptTokens = attempt.inputTokens + attempt.cacheReadTokens + attempt.cacheWriteTokens;
    const rate = spec.longPrompt && promptTokens > spec.longPrompt.threshold ? spec.longPrompt.prices : spec.prices;
    total +=
      (attempt.inputTokens * rate.input +
        attempt.outputTokens * rate.output +
        attempt.cacheReadTokens * rate.cacheRead +
        attempt.cacheWriteTokens * rate.cacheWrite) /
      ONE_MILLION;
  }
  return total;
}
