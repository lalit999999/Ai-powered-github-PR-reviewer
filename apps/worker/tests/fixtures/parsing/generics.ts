// Generic functions and classes with non-trivial type parameters (§2.6) — must not
// confuse symbol detection or blow up the stored signature.
export function firstMatch<T extends { id: string }, U = T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  return items.find(predicate);
}

export class Cache<K extends string | number, V> {
  private store = new Map<K, V>();

  get(key: K): V | undefined {
    return this.store.get(key);
  }

  set(key: K, value: V): void {
    this.store.set(key, value);
  }
}
