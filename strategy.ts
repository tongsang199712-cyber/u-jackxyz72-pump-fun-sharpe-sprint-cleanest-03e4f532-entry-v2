// Steady Scalper — a pump.fun paper-trading bot for agent-fun/replay/v2.
//
// The idea, in one line: follow the creator's own opening buy, but only when it is
// a serious-but-not-whale-sized commitment, take a small fixed stake, and get out
// quickly on a fixed take-profit, a fixed stop-loss, a trailing stop, a hard time
// cap, or the creator dumping. Everything is a pure function of the batches the
// harness feeds in: no clock, no randomness, no I/O, no network.
//
// Entry ("opening trade"): on the batch that carries a mint's first trade, look at
// the mint's opening tape in chain order. The creator's first buy in that tape is
// the opening buy. If it is between MIN_CREATOR_OPEN_BUY and MAX_CREATOR_OPEN_BUY
// (0.2–1.25 SOL) and no creator sell precedes it, buy once, immediately, with
// STAKE_LAMPORTS (0.30 SOL) capped at the harness size cap (1% of the real SOL
// reserve). One buy per coin, at most MAX_OPEN_POSITIONS coins open at once.
//
// Exits (all evaluated every batch, exits before entries):
//   - take-profit: position value >= cost * (1 + TAKE_PROFIT_BPS)
//   - stop-loss:   position value <= cost * (1 - STOP_LOSS_BPS)
//   - trailing:    once the value has reached cost * (1 + TRAIL_ARM_BPS), exit
//                  when it falls TRAIL_BPS below its best value since opening
//   - max hold:    MAX_HOLD_SLOTS slots after the buy filled
//   - creator dump: the creator sells CREATOR_SELL_EXIT_LAMPORTS (0.1 SOL) or more
//                  in one trade after our buy was decided
//
// Position value is the SOL a full sell would pay right now at the latest virtual
// reserves, after the curve's protocol + creator fees (95 + 30 bps) and one
// transaction fee. Cost is the position's cost_lamports (curve fees included) plus
// the transaction fees the buy paid.

import {
  BPS,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Creator's opening buy must be at least this (lamports). */
  minCreatorOpenBuyLamports: bigint;
  /** Creator's opening buy must be at most this (lamports). */
  maxCreatorOpenBuyLamports: bigint;
  /** SOL to stake per trade (lamports), before the harness size cap. */
  stakeLamports: bigint;
  /** Smallest single buy worth paying the transaction fee for (lamports). */
  minBuyLamports: bigint;
  /** Take-profit, in bps over cost. */
  takeProfitBps: number;
  /** Stop-loss, in bps under cost. */
  stopLossBps: number;
  /** Trailing stop arms once value is this far over cost (bps). */
  trailArmBps: number;
  /** Trailing stop exits on a fall of this much (bps) from the best value. */
  trailBps: number;
  /** Exit after holding this many slots (counted from the buy's fill slot). */
  maxHoldSlots: number;
  /** One creator sell of at least this (lamports) exits the position. */
  creatorSellExitLamports: bigint;
  /** Slippage allowed on every order (bps); wide open so a fill is never refused
   *  for the price moving during the 2-slot latency. */
  maxSlippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  minCreatorOpenBuyLamports: (LAMPORTS_PER_SOL * 2n) / 10n, // 0.2 SOL
  maxCreatorOpenBuyLamports: (LAMPORTS_PER_SOL * 5n) / 4n, // 1.25 SOL
  stakeLamports: (LAMPORTS_PER_SOL * 3n) / 10n, // 0.30 SOL
  minBuyLamports: 50_000_000n, // 0.05 SOL
  takeProfitBps: 2500, // +25%
  stopLossBps: 1200, // -12%
  trailArmBps: 1500, // +15%
  trailBps: 1000, // -10% from the best value
  maxHoldSlots: 100,
  creatorSellExitLamports: LAMPORTS_PER_SOL / 10n, // 0.1 SOL
  maxSlippageBps: 10_000,
};

/** Curve fees the replay charges on a trade: protocol 95 bps + creator 30 bps. */
const FEE_BPS = 125n;

/** What selling `tokens` against virtual reserves (vq, vt) would pay, after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n || vq <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * FEE_BPS + BPS - 1n) / BPS;
}

interface Coin {
  mint: Pubkey;
  creator: Pubkey;
  /** Slot of the CreateEvent, or null when first seen through a trade. */
  createSlot: number | null;
  /** Trades seen on this mint. */
  trades: number;
  /** The opening tape has been judged (eligible or not). */
  openingDecided: boolean;
  /** The opening tape passed: the creator's opening buy was 0.2–1.25 SOL. */
  openingOk: boolean;
  /** A buy was sent (or the coin was ruled out): never buy it again. */
  done: boolean;
  /** Its CompleteEvent arrived: no more orders. */
  complete: boolean;
  /** Slots where the creator sold >= creatorSellExitLamports in one trade. */
  bigCreatorSells: number[];
}

interface Held {
  /** Slot the buy was decided on (the batch we sent it in). */
  decidedSlot: number;
  /** Slot the buy filled at. */
  openedSlot: number;
  /** Transaction fees paid on the buy's fills. */
  txPaid: bigint;
  /** Best position value seen since opening (lamports). */
  best: bigint;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  /** Mints with a buy in flight: mint -> slot the buy was decided on. */
  const buying = new Map<Pubkey, number>();

  function coinFor(mint: Pubkey, creator: Pubkey, createSlot: number | null): Coin {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        mint,
        creator,
        createSlot,
        trades: 0,
        openingDecided: false,
        openingOk: false,
        done: false,
        complete: false,
        bigCreatorSells: [],
      };
      coins.set(mint, c);
    }
    return c;
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'buy') return true;
    }
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'sell') return true;
    }
    return false;
  }

  /** Fold this batch's events into the coin book, judging each mint's opening tape. */
  function readEvents(batch: Batch): void {
    // First trades of mints not yet judged, in chain order, grouped per mint.
    const openingTrades = new Map<Pubkey, { isBuy: boolean; user: Pubkey; sol: bigint }[]>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coinFor(e.mint, e.creator, e.slot);
      } else if (e.event === 'TradeEvent') {
        const c = coinFor(e.mint, e.creator, null);
        c.trades += 1;
        const sol = BigInt(e.sol_amount);
        if (!e.is_buy && e.user === c.creator && sol >= P.creatorSellExitLamports) {
          c.bigCreatorSells.push(e.slot);
        }
        if (!c.openingDecided) {
          let tape = openingTrades.get(e.mint);
          if (tape === undefined) {
            tape = [];
            openingTrades.set(e.mint, tape);
          }
          tape.push({ isBuy: e.is_buy, user: e.user, sol });
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
    // Judge each opening tape: the creator's first buy in it is the opening buy.
    for (const [mint, tape] of openingTrades) {
      const c = coins.get(mint);
      if (c === undefined) continue;
      c.openingDecided = true;
      for (const t of tape) {
        if (!t.isBuy && t.user === c.creator) break; // creator sold before buying: no entry
        if (t.isBuy && t.user === c.creator) {
          if (t.sol >= P.minCreatorOpenBuyLamports && t.sol <= P.maxCreatorOpenBuyLamports) {
            c.openingOk = true;
          }
          break;
        }
      }
    }
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();

      // Fills: track buys (open a Held) and closes (drop the Held).
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          buying.delete(f.mint);
          continue;
        }
        if (f.side === 'buy' && f.status === 'filled') {
          const decided = buying.get(f.mint) ?? state.slot;
          buying.delete(f.mint);
          held.set(f.mint, {
            decidedSlot: decided,
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
          });
        } else if (f.side === 'buy' && f.status !== 'filled') {
          buying.delete(f.mint);
        } else if (f.side === 'sell' && f.status === 'filled') {
          held.delete(f.mint);
          selling.delete(f.mint);
        } else if (f.side === 'sell') {
          selling.delete(f.mint);
        }
        const h = held.get(f.mint);
        if (h !== undefined && f.status !== 'rejected') {
          h.txPaid += BigInt(f.tx_fee_lamports);
        }
      }
      for (const mint of [...selling]) {
        if (!hasPendingSell(state, mint)) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) {
          held.delete(mint);
        }
      }

      // Latest virtual reserves per held mint, from this batch's marks.
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }
      const reserves = (mint: Pubkey): { vq: bigint; vt: bigint } | undefined => {
        const mk = marks.get(mint);
        if (mk !== undefined) return mk;
        const cv = state.curves.get(mint);
        if (cv === undefined) return undefined;
        return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      };

      // Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { decidedSlot: state.slot, openedSlot: state.slot, txPaid: tx, best: 0n };
          held.set(mint, h);
        }
        const rv = reserves(mint);
        if (rv === undefined) continue;
        const value = sellValue(pos.token_amount, rv.vq, rv.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.takeProfitBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.stopLossBps))) exit = true;
          if (
            h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) &&
            value * BPS <= h.best * (BPS - BigInt(P.trailBps))
          ) {
            exit = true;
          }
        }
        if (state.slot - h.openedSlot >= P.maxHoldSlots) exit = true;
        if (c !== undefined) {
          for (const s of c.bigCreatorSells) {
            if (s >= h.decidedSlot) {
              exit = true;
              break;
            }
          }
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: P.maxSlippageBps });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: one buy per coin, on its opening trade only.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (!c.openingOk || c.done || c.complete) continue;
        if (open >= state.hello.caps.max_open_positions) break;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) {
          c.done = true;
          continue;
        }
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = P.stakeLamports < maxBuy ? P.stakeLamports : maxBuy;
        if (amount < P.minBuyLamports) {
          c.done = true;
          continue;
        }
        if (free < amount + tx) {
          c.done = true;
          continue;
        }
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.maxSlippageBps });
        free -= amount + tx;
        open += 1;
        c.done = true;
        buying.set(c.mint, state.slot);
      }
      return orders;
    },
  };
}
