/**
 * End-to-end benchmark for partial (diff) updates vs full replace.
 *
 * Intended usage:
 *  - Place this file at denops/tests/bench-e2e.ts in the repository.
 *  - Load it in a running Neovim session that has denops available.
 *
 * Example run (from inside Neovim with denops loaded):
 *   :luado vim.fn['denops#server#call']('denops/tests/bench-e2e.ts#run')
 *
 * Or, if you use a test harness for denops that can import and run this module,
 * invoke the exported `run` function with a Denops object.
 *
 * What this script does (high level):
 *  - Creates a temporary new buffer inside Neovim (via denops calls).
 *  - Fills it with `totalLines` lines (base content).
 *  - For each ratio (change fraction), mutates a copy of the base lines and:
 *      1) Measures the time to perform a *full replace* (nvim_buf_set_lines).
 *      2) Measures the time to perform a *partial update* by sending a minimal
 *         single replace operation to the autoload handler `ddu#ui#ff#_apply_operations`.
 *  - Repeats `iterations` times for averaging and prints results as echomsg.
 *
 * Note:
 *  - This file assumes you're running inside Neovim with denops available.
 *  - The purpose is to include denops RPC round-trip times in the measurement,
 *    contrary to the vim-local bench script which only measured buffer-side time.
 *
 * If this exact import style doesn't match your environment, adapt the `run`
 * function invocation accordingly.
 */

import type { Denops } from "@denops/std";

/** Generate base lines (1..n) with a long-ish payload per line. */
function makeLines(total: number): string[] {
  const out: string[] = [];
  for (let i = 1; i <= total; i++) {
    out.push(`line ${i}: ${"x".repeat(64)}`);
  }
  return out;
}

// Helper: compute stats
function stats(times: number[]) {
  const sorted = times.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const avg = sum / sorted.length;
  const p = (p: number) => {
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)));
    return sorted[idx];
  };
  return {
    avg,
    p75: p(0.75),
    p99: p(0.99),
  };
}

/** Deterministic mutate: append " [CHANGED]" to ~ratio fraction of lines. */
function mutateLines(lines: string[], ratio: number): string[] {
  const n = lines.length;
  if (n === 0) return lines.slice();
  const count = Math.floor(n * ratio);
  const out = lines.slice();
  for (let i = 0; i < count; i++) {
    const idx = (i * 2654435761) % n;
    out[idx] = out[idx] + " [CHANGED]";
  }
  return out;
}

/** Compute simple single middle-run replace op (1-indexed start/end). */
function computeSingleReplaceOp(prev: string[], next: string[]) {
  const n = prev.length;
  const m = next.length;
  let i = 0;
  while (i < n && i < m && prev[i] === next[i]) i++;
  if (i === n && i === m) {
    return null;
  }
  let j = n - 1;
  let k = m - 1;
  while (j >= i && k >= i && prev[j] === next[k]) {
    j--;
    k--;
  }
  const start = i + 1;
  const end = j >= i ? j + 1 : i; // inclusive end (1-indexed). If nothing in prev, end==i
  const lines = k >= i ? next.slice(i, k + 1) : [];
  return { start, end, lines };
}

/** Utility: sleep ms */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run E2E bench; callable from denops environment. */
export async function run(denops: Denops): Promise<void> {
  // Config: tune these as you like
  const cases = [
    { totalLines: 500, ratios: [0.05, 0.30, 1.0] },
    // { totalLines: 1000, ratios: [0.05, 0.30, 1.0] }, // uncomment to add 1000-line case
  ];
  const iterations = 5;

  // Create a new scratch buffer to operate on
  const bufnr = await denops.call("nvim_create_buf", false, true) as number;
  // Ensure buffer exists and is loaded
  await denops.call("bufload", bufnr);

  // Ensure autoload handler exists (try to autoload)
  try {
    // safe noop call to trigger autoload if available
    await denops.call("ddu#ui#ff#_apply_operations", bufnr, []);
  } catch (_e) {
    // ignore: handler may not be present yet
  }

  for (const c of cases) {
    const base = makeLines(c.totalLines);

    for (const ratio of c.ratios) {
      // Prepare mutated lines for this scenario
      const mutated = mutateLines(base, ratio);

      // Prepare prev state in buffer (set to base)
      await denops.call("nvim_buf_set_lines", bufnr, 0, -1, false, base);

      // Give Neovim a moment to settle
      await sleep(5);

      // FULL replace measurement (set_lines from 0..-1)
      const fullTimes: number[] = [];
      for (let it = 0; it < iterations; it++) {
        const t0 = performance.now();
        // use nvim_buf_set_lines for full replace (0, -1)
        await denops.call("nvim_buf_set_lines", bufnr, 0, -1, false, mutated);
        const elapsed = performance.now() - t0;
        fullTimes.push(elapsed);
        // restore prev for next iteration
        await denops.call("nvim_buf_set_lines", bufnr, 0, -1, false, base);
        // brief pause to avoid back-to-back artifacts
        await sleep(2);
      }

      // PARTIAL replace measurement using single replace op via denops call
      // We compute the single-replace op from the buffer-side prev (read) and mutated next
      const prevLines = await denops.call("nvim_buf_get_lines", bufnr, 0, -1, false) as string[];
      const op = computeSingleReplaceOp(prevLines, mutated);
      const partTimes: number[] = [];

      if (op === null) {
        // noop
        for (let it = 0; it < iterations; it++) {
          const t0 = performance.now();
          // call handler with empty ops -> nothing to do
          try {
            await denops.call("ddu#ui#ff#_apply_operations", bufnr, []);
          } catch (_e) {
            // if handler absent, we still want to measure a minimal denops.call
            await denops.call("nvim_buf_set_lines", bufnr, 0, -1, false, base);
          }
          partTimes.push(performance.now() - t0);
          await sleep(2);
        }
      } else {
        const ops = [
          {
            op: "replace_lines",
            start: op.start,
            end: op.end,
            lines: op.lines,
          },
        ];
        for (let it = 0; it < iterations; it++) {
          const t0 = performance.now();
          try {
            await denops.call("ddu#ui#ff#_apply_operations", bufnr, ops);
          } catch (_e) {
            // fallback: if handler not present, emulate via set_lines
            await denops.call("nvim_buf_set_lines", bufnr, op.start - 1, op.end, false, op.lines);
          }
          partTimes.push(performance.now() - t0);
          // restore prev for next iteration
          await denops.call("nvim_buf_set_lines", bufnr, 0, -1, false, base);
          await sleep(2);
        }
      }

      const fullStats = stats(fullTimes);
      const partStats = partTimes.length > 0 ? stats(partTimes) : null;

      // Report via echomsg so it appears in messages and is easy to capture
      const report = [
        `bench: lines=${c.totalLines} ratio=${ratio.toFixed(2)} iters=${iterations}`,
        `full_avg=${fullStats.avg.toFixed(3)}ms full_p75=${fullStats.p75.toFixed(3)}ms full_p99=${fullStats.p99.toFixed(3)}ms`,
      ];

      if (partStats) {
        report.push(`partial_avg=${partStats.avg.toFixed(3)}ms partial_p75=${partStats.p75.toFixed(3)}ms partial_p99=${partStats.p99.toFixed(3)}ms`);
      } else {
        report.push("partial=N/A");
      }

      await denops.cmd(`echomsg "${report.join(" ")}"`);
    }
  }

  // cleanup: delete the temporary buffer
  try {
    await denops.call("nvim_buf_delete", bufnr, { force: true });
  } catch (_e) {
    // ignore
  }
}
