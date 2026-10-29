export type DiffOp = { type: 'same' | 'add' | 'del'; text: string };

// Above this many cells the LCS table gets too big; the changed block is then shown
// as "all removed, all added", which is still correct, just less granular.
const MAX_LCS_CELLS = 4_000_000;

/** Line diff of two texts (common prefix/suffix trimmed, LCS in between). */
export function diffLines(before: string, after: string): DiffOp[] {
  const a = before.split('\n');
  const b = after.split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops: DiffOp[] = a.slice(0, start).map((text) => ({ type: 'same', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  if (n * m > MAX_LCS_CELLS) {
    midA.forEach((text) => ops.push({ type: 'del', text }));
    midB.forEach((text) => ops.push({ type: 'add', text }));
  } else if (n > 0 || m > 0) {
    // lcs[i][j] = LCS length of midA[i..] and midB[j..], stored row-major
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = midA[i] === midB[j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ type: 'same', text: midA[i] });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
        ops.push({ type: 'del', text: midA[i++] });
      } else {
        ops.push({ type: 'add', text: midB[j++] });
      }
    }
    while (i < n) ops.push({ type: 'del', text: midA[i++] });
    while (j < m) ops.push({ type: 'add', text: midB[j++] });
  }

  a.slice(endA).forEach((text) => ops.push({ type: 'same', text }));
  return ops;
}

/**
 * Collapse long runs of unchanged lines to `context` lines around each change;
 * `null` entries mark where lines were hidden.
 */
export function withContext(ops: DiffOp[], context = 3): Array<DiffOp | null> {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.type === 'same') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true;
  });
  const out: Array<DiffOp | null> = [];
  ops.forEach((op, idx) => {
    if (keep[idx]) out.push(op);
    else if (out[out.length - 1] !== null) out.push(null);
  });
  return out;
}
