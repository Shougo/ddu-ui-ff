/**
 * Benchmark for computeLineDiff() in diff.ts.
 *
 * Run with:
 *   deno bench --allow-read denops/tests/bench-diff.ts
 *
 * The suite covers three representative mutation ratios against a
 * 500-line dataset:
 *
 *  •  5% change  – typical incremental-search update
 *  • 30% change  – moderate filter change (at the default threshold)
 *  • 100% change – full replacement (worst case)
 *
 * Each benchmark also runs with threshold=0.3 (default) and
 * threshold=1.0 (always partial) to show the impact of the threshold.
 */

import { computeLineDiff } from "../@ddu-uis/ff/diff.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate `n` stable line strings that look like real ddu output. */
function makeLines(n: number, prefix = "item"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
}

/**
 * Apply a random mutation to `fraction` of lines chosen uniformly at
 * random (deterministic with a fixed seed via simple LCG).
 */
function mutateFraction(lines: string[], fraction: number): string[] {
  const out = lines.slice();
  // Simple deterministic LCG so the benchmark is reproducible.
  let seed = 0x12345678;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const mutateCount = Math.floor(lines.length * fraction);
  for (let i = 0; i < mutateCount; i++) {
    const idx = Math.floor(rand() * lines.length);
    out[idx] = `changed_${idx}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

const BASE_500 = makeLines(500);
const CURR_5PCT = mutateFraction(BASE_500, 0.05);
const CURR_30PCT = mutateFraction(BASE_500, 0.30);
const CURR_100PCT = makeLines(500, "replaced");

// Append-only scenario: 500 → 525 lines (5% growth at the end)
const CURR_APPEND = [...BASE_500, ...makeLines(25, "appended")];

// Shrink scenario: 500 → 475 lines (remove last 25)
const CURR_SHRINK = BASE_500.slice(0, 475);

// ---------------------------------------------------------------------------
// Benchmarks – threshold 0.3 (default)
// ---------------------------------------------------------------------------

Deno.bench("diff  5% change  threshold=0.30", () => {
  computeLineDiff(BASE_500, CURR_5PCT, 0.30);
});

Deno.bench("diff 30% change  threshold=0.30", () => {
  computeLineDiff(BASE_500, CURR_30PCT, 0.30);
});

Deno.bench("diff 100% change threshold=0.30", () => {
  computeLineDiff(BASE_500, CURR_100PCT, 0.30);
});

Deno.bench("diff append (+5%) threshold=0.30", () => {
  computeLineDiff(BASE_500, CURR_APPEND, 0.30);
});

Deno.bench("diff shrink (-5%) threshold=0.30", () => {
  computeLineDiff(BASE_500, CURR_SHRINK, 0.30);
});

Deno.bench("diff noop        threshold=0.30", () => {
  computeLineDiff(BASE_500, BASE_500.slice(), 0.30);
});

// ---------------------------------------------------------------------------
// Benchmarks – threshold 1.0 (always partial when possible)
// ---------------------------------------------------------------------------

Deno.bench("diff  5% change  threshold=1.00", () => {
  computeLineDiff(BASE_500, CURR_5PCT, 1.0);
});

Deno.bench("diff 30% change  threshold=1.00", () => {
  computeLineDiff(BASE_500, CURR_30PCT, 1.0);
});
