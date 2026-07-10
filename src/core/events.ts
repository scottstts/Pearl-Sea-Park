type Listener<T> = (payload: T) => void

/** Minimal typed pub/sub used for cross-system signals. */
export class EventBus<M extends Record<string, unknown>> {
  private listeners = new Map<keyof M, Set<Listener<never>>>()

  on<K extends keyof M>(type: K, fn: Listener<M[K]>): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(fn as Listener<never>)
    return () => set.delete(fn as Listener<never>)
  }

  once<K extends keyof M>(type: K, fn: Listener<M[K]>): () => void {
    const off = this.on(type, (payload) => {
      off()
      fn(payload)
    })
    return off
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const set = this.listeners.get(type)
    if (!set) return
    for (const fn of [...set]) (fn as Listener<M[K]>)(payload)
  }
}
