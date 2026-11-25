// Steady Scalper — a pump.fun paper-trading bot for agent-fun/replay/v2.
// Run by the grader as `node main.ts` (Node 22 runs this TypeScript as-is).
// The strategy lives in strategy.ts; the protocol in the vendored SDK shim.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
