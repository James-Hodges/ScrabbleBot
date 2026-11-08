// Winning-bid percentiles per letter and match phase (S2-1).
//
// The numbers come from prices.json, which analysis/export_prices.py builds
// from the public match history (the "Winning bids per letter and phase"
// query in analysis/analyze.sql). A "winning bid" is the top bid in a sold
// auction, i.e. what we would have had to beat, not the Vickrey price paid.
//
// Phases are tuned for 68-auction (6-player) matches, the only size in the
// sample. For other match sizes, mapping by auctions left instead of round
// number is a later tuning question.

import fs from "node:fs";
import path from "node:path";

export type Pct = 25 | 50 | 75 | 90;
export type PhaseName = "early" | "mid" | "late";

export interface PriceCell {
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  /** Samples behind this cell (all-rounds count when fallback is true). */
  n: number;
  /** True when the phase had too few samples and all-rounds numbers are used. */
  fallback?: boolean;
}

export interface PriceTable {
  generatedAt: string;
  sample: { matches: number; auctions: number; fromDate: string; toDate: string; minN: number };
  phases: { name: PhaseName; rounds: [number, number] }[];
  letters: Record<string, Record<PhaseName, PriceCell>>;
}

const jsonPath = path.join(path.dirname(new URL(import.meta.url).pathname), "prices.json");

/** The table, read once at import. */
export const PRICES: PriceTable = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

/** Phase for a 1-based round. Rounds past the last phase count as "late". */
export function phaseForRound(round: number): PhaseName {
  for (const p of PRICES.phases) if (round <= p.rounds[1]) return p.name;
  return "late";
}

/** Winning-bid percentile for a letter in the given round. */
export function priceFor(letter: string, round: number, pct: Pct): number {
  const cells = PRICES.letters[letter.toUpperCase()];
  if (!cells) throw new Error(`no price data for letter ${letter}`);
  return cells[phaseForRound(round)][`p${pct}`];
}
