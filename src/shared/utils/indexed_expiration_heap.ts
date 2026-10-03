interface Expiration<K> {
  readonly key: K;
  readonly expiresAtMs: number;
}

/** One heap node per key; renewals never leave stale expiration records behind. */
export class IndexedExpirationHeap<K> {
  private readonly nodes: Expiration<K>[] = [];
  private readonly positions = new Map<K, number>();

  get size(): number {
    return this.nodes.length;
  }
  peek(): Expiration<K> | undefined {
    return this.nodes[0];
  }

  set(key: K, expiresAtMs: number): void {
    const position = this.positions.get(key);
    if (position === undefined) {
      this.positions.set(key, this.nodes.length);
      this.nodes.push({ key, expiresAtMs });
      this.up(this.nodes.length - 1);
      return;
    }
    this.nodes[position] = { key, expiresAtMs };
    this.down(this.up(position));
  }

  delete(key: K): void {
    const position = this.positions.get(key);
    if (position === undefined) return;
    const last = this.nodes.pop()!;
    this.positions.delete(key);
    if (position < this.nodes.length) {
      this.nodes[position] = last;
      this.positions.set(last.key, position);
      this.down(this.up(position));
    }
  }

  takeExpired(nowMs: number): K | undefined {
    const first = this.peek();
    if (first === undefined || first.expiresAtMs > nowMs) return undefined;
    this.delete(first.key);
    return first.key;
  }

  clear(): void {
    this.nodes.length = 0;
    this.positions.clear();
  }

  private swap(a: number, b: number): void {
    const left = this.nodes[a]!,
      right = this.nodes[b]!;
    this.nodes[a] = right;
    this.nodes[b] = left;
    this.positions.set(right.key, a);
    this.positions.set(left.key, b);
  }

  private up(position: number): number {
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2);
      if (this.nodes[parent]!.expiresAtMs <= this.nodes[position]!.expiresAtMs) break;
      this.swap(parent, position);
      position = parent;
    }
    return position;
  }

  private down(position: number): void {
    for (;;) {
      const left = position * 2 + 1,
        right = left + 1;
      let smallest = position;
      if (
        left < this.nodes.length &&
        this.nodes[left]!.expiresAtMs < this.nodes[smallest]!.expiresAtMs
      )
        smallest = left;
      if (
        right < this.nodes.length &&
        this.nodes[right]!.expiresAtMs < this.nodes[smallest]!.expiresAtMs
      )
        smallest = right;
      if (smallest === position) return;
      this.swap(position, smallest);
      position = smallest;
    }
  }
}
