export type Listener<T> = (value: T) => void;

/** Minimal typed pub/sub — the only bridge between the engine and React. */
export class Emitter<E extends Record<string, unknown>> {
  private listeners = new Map<keyof E, Set<Listener<never>>>();

  on<K extends keyof E>(key: K, fn: Listener<E[K]>): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(fn as Listener<never>);
    return () => set.delete(fn as Listener<never>);
  }

  emit<K extends keyof E>(key: K, value: E[K]): void {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const fn of set) (fn as Listener<E[K]>)(value);
  }

  clear(): void {
    this.listeners.clear();
  }
}
