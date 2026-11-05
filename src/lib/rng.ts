/** Deterministic PRNG (mulberry32) so the seeded demo restaurant is reproducible. */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Random {
  next(): number;
  int(min: number, max: number): number;
  float(min: number, max: number, digits?: number): number;
  pick<T>(items: readonly T[]): T;
  pickMany<T>(items: readonly T[], count: number): T[];
  chance(probability: number): boolean;
  /** Weighted pick: entries are [value, weight]. */
  weighted<T>(entries: readonly [T, number][]): T;
}

export function random(seed: number): Random {
  const next = rng(seed);
  return {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    float: (min, max, digits = 2) => {
      const factor = 10 ** digits;
      return Math.round((next() * (max - min) + min) * factor) / factor;
    },
    pick: (items) => items[Math.floor(next() * items.length)],
    pickMany: (items, count) => {
      const pool = [...items];
      const out: typeof pool = [];
      while (out.length < count && pool.length) out.push(pool.splice(Math.floor(next() * pool.length), 1)[0]);
      return out;
    },
    chance: (probability) => next() < probability,
    weighted: (entries) => {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      let roll = next() * total;
      for (const [value, weight] of entries) {
        roll -= weight;
        if (roll <= 0) return value;
      }
      return entries[entries.length - 1][0];
    },
  };
}
