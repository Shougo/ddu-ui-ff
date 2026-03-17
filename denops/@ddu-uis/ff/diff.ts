/**
 * Line-diff utilities for ddu-ui-ff partial buffer updates.
 *
 * computeLineDiff() compares the previously rendered lines with the
 * newly computed lines and returns the minimal update descriptor.
 * The caller can then send only the changed portion to Vim/Neovim
 * rather than replacing the whole buffer every redraw.
 */

/** Descriptor returned by computeLineDiff(). */
export type LineDiffInfo =
  /** No change at all — skip buffer write entirely. */
  | { type: "noop" }
  /** Too many changes — caller should do a full replace. */
  | { type: "full" }
  /**
   * Only new lines appended at the end.
   * Apply: setbufline(bufnr, startLine, lines)
   */
  | { type: "append"; startLine: number; lines: string[] }
  /**
   * Lines removed from the tail only.
   * Apply: deletebufline(bufnr, keepLines+1, '$')
   */
  | { type: "shrink"; keepLines: number }
  /**
   * A contiguous range of lines changed (same total length).
   * Apply: setbufline(bufnr, startLine, lines)
   */
  | { type: "update"; startLine: number; lines: string[] };

/**
 * Compute a minimal diff between `prev` and `curr` line arrays.
 *
 * The algorithm is O(N) — it only scans from both ends to find the
 * changed contiguous region and never builds an LCS table.
 *
 * @param prev      Lines rendered in the previous redraw.
 * @param curr      Lines to render in the current redraw.
 * @param threshold Fraction [0, 1].  When the changed-line count
 *                  divided by total lines exceeds this value the
 *                  function returns `{ type: "full" }` so the caller
 *                  falls back to a whole-buffer replace.
 *                  Use 0 to always request a full replace (disables
 *                  partial updates), use 1 to always try partial.
 *
 * @example
 * ```ts
 * import { computeLineDiff } from "./diff.ts";
 * import { assertEquals } from "@std/assert";
 *
 * // Identical arrays → noop
 * assertEquals(
 *   computeLineDiff(["a", "b"], ["a", "b"], 0.3),
 *   { type: "noop" },
 * );
 *
 * // Empty prev → full
 * assertEquals(computeLineDiff([], ["a"], 0.3).type, "full");
 *
 * // Both empty → noop
 * assertEquals(
 *   computeLineDiff([], [], 0.3),
 *   { type: "noop" },
 * );
 *
 * // Append-only
 * assertEquals(
 *   computeLineDiff(["a", "b"], ["a", "b", "c"], 0.3),
 *   { type: "append", startLine: 3, lines: ["c"] },
 * );
 *
 * // Shrink-only
 * assertEquals(
 *   computeLineDiff(["a", "b", "c"], ["a", "b"], 0.3),
 *   { type: "shrink", keepLines: 2 },
 * );
 *
 * // Single line changed in the middle (below threshold)
 * const upd = computeLineDiff(["a","b","c","d","e"], ["a","X","c","d","e"], 0.3);
 * assertEquals(upd, { type: "update", startLine: 2, lines: ["X"] });
 *
 * // Many lines changed — exceeds threshold → full
 * assertEquals(
 *   computeLineDiff(["a","b","c","d"], ["X","X","X","X"], 0.3).type,
 *   "full",
 * );
 *
 * // threshold=0 disables partial updates — any change returns full
 * assertEquals(
 *   computeLineDiff(["a","b"], ["a","X"], 0).type,
 *   "full",
 * );
 * ```
 */
export function computeLineDiff(
  prev: string[],
  curr: string[],
  threshold: number,
): LineDiffInfo {
  // Both empty — nothing to do.
  if (prev.length === 0 && curr.length === 0) {
    return { type: "noop" };
  }

  // No previous state — we have nothing to compare against.
  if (prev.length === 0) {
    return { type: "full" };
  }

  const minLen = Math.min(prev.length, curr.length);

  // Scan forward to find the first differing index.
  let firstDiff = 0;
  while (firstDiff < minLen && prev[firstDiff] === curr[firstDiff]) {
    firstDiff++;
  }

  // The common prefix covers the entire shorter array.
  if (firstDiff === minLen) {
    if (prev.length === curr.length) {
      return { type: "noop" };
    }
    if (curr.length > prev.length) {
      // Lines appended at the end.
      return {
        type: "append",
        startLine: prev.length + 1,
        lines: curr.slice(prev.length),
      };
    }
    // Lines removed from the end.
    return { type: "shrink", keepLines: curr.length };
  }

  // There is at least one changed line.  Scan backward from both ends
  // to find the last differing index in each array.
  let lastDiffPrev = prev.length - 1;
  let lastDiffCurr = curr.length - 1;
  while (
    lastDiffPrev > firstDiff &&
    lastDiffCurr > firstDiff &&
    prev[lastDiffPrev] === curr[lastDiffCurr]
  ) {
    lastDiffPrev--;
    lastDiffCurr--;
  }

  // Check the threshold.  changedCount is the size of the changed
  // region in the *new* array.
  const changedCount = lastDiffCurr - firstDiff + 1;
  const totalCount = Math.max(prev.length, curr.length);
  if (changedCount / totalCount > threshold) {
    return { type: "full" };
  }

  // When the total line count changes AND there are content changes,
  // handling the combination cleanly requires a full replace.
  if (prev.length !== curr.length) {
    return { type: "full" };
  }

  // Same-length partial replacement.
  return {
    type: "update",
    startLine: firstDiff + 1, // 1-indexed (Vim line numbers)
    lines: curr.slice(firstDiff, lastDiffCurr + 1),
  };
}
