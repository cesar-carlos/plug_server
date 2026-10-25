/**
 * Quickselect-based percentile: O(n) average vs O(n log n) for full sort.
 * Mutates a copy of `values` internally.
 */
export const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const arr = [...values];
  const rank = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const pivot = arr[Math.floor((lo + hi) / 2)]!;
    let left = lo;
    let right = hi;
    // Advance both cursors on ties to avoid peeling off equal values one at a time.
    while (left <= right) {
      while (arr[left]! < pivot) left += 1;
      while (arr[right]! > pivot) right -= 1;
      if (left <= right) {
        const value = arr[left]!;
        arr[left] = arr[right]!;
        arr[right] = value;
        left += 1;
        right -= 1;
      }
    }
    if (rank <= right) hi = right;
    else if (rank >= left) lo = left;
    else break;
  }
  return arr[rank] ?? 0;
};
