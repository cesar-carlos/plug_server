/**
 * Quickselect-based percentile: O(n) average vs O(n log n) for full sort.
 * Mutates a copy of `values` internally.
 */
export const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) {
    return 0;
  }

  const arr = [...values];
  const rank = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));

  const partition = (lo: number, hi: number, pivotIdx: number): number => {
    const pivot = arr[pivotIdx]!;
    [arr[pivotIdx], arr[hi]] = [arr[hi]!, arr[pivotIdx]!];
    let store = lo;
    for (let i = lo; i < hi; i++) {
      if (arr[i]! <= pivot) {
        [arr[store], arr[i]] = [arr[i]!, arr[store]!];
        store += 1;
      }
    }
    [arr[store], arr[hi]] = [arr[hi]!, arr[store]!];
    return store;
  };

  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const pivotIdx = Math.floor((lo + hi) / 2);
    const pIdx = partition(lo, hi, pivotIdx);
    if (pIdx === rank) {
      return arr[rank] ?? 0;
    }
    if (pIdx < rank) {
      lo = pIdx + 1;
    } else {
      hi = pIdx - 1;
    }
  }
  return arr[rank] ?? 0;
};
