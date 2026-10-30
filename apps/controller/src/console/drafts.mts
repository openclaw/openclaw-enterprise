// Drafts live only in this document. Editors explicitly select non-credential state.
const captured = (value: unknown): boolean => value !== undefined;

export function createDraftStore() {
  const snapshots = new Map<string, unknown>();
  const captures = new Map<string, () => unknown>();
  const unsavedChecks = new Map<string, typeof captured>();
  // The newest capture tracked under each key, kept after a flush: it owns that key's draft. Held
  // weakly, so a view left for good (and its detached nodes) can still be collected.
  const owners = new Map<string, WeakRef<() => unknown>>();
  const snapshot = (key: string, capture: () => unknown) => {
    const value = capture();
    if (value === undefined) {
      snapshots.delete(key);
    } else {
      snapshots.set(key, value);
    }
  };
  const isUnsaved = (key: string, value: unknown) => (unsavedChecks.get(key) ?? captured)(value);
  return {
    flush() {
      for (const [key, capture] of captures) {
        snapshot(key, capture);
      }
      captures.clear();
    },
    suspend() {
      const suspended = new Map(captures);
      this.flush();
      return () => {
        for (const [key, capture] of suspended) {
          captures.set(key, capture);
        }
      };
    },
    clear() {
      captures.clear();
      snapshots.clear();
      unsavedChecks.clear();
      owners.clear();
    },
    // Forgets the drafts of every Namespace a successful read no longer lists. Each key's first
    // part names its Namespace (see scope).
    retainNamespaces(namespaceIds: Iterable<string>) {
      const kept = new Set<string | null>(namespaceIds);
      for (const entries of [captures, snapshots, unsavedChecks, owners]) {
        for (const key of entries.keys()) {
          const [namespaceId]: [string | null, ...string[]] = JSON.parse(key);
          if (!kept.has(namespaceId)) {
            entries.delete(key);
          }
        }
      }
    },
    // Whether a reload or tab close would lose unsaved work, shown or kept from an earlier page.
    hasUnsaved() {
      for (const [key, capture] of captures) {
        if (isUnsaved(key, capture())) {
          return true;
        }
      }
      for (const [key, value] of snapshots) {
        if (!captures.has(key) && isUnsaved(key, value)) {
          return true;
        }
      }
      return false;
    },
    scope(namespaceId: string | null, ...parts: string[]) {
      const keyFor = (name: string) => JSON.stringify([namespaceId, ...parts, name]);
      return {
        // A confirmed read denial retires this Agent's drafts, including parked tabs.
        clear() {
          for (const entries of [captures, snapshots, unsavedChecks, owners]) {
            for (const key of entries.keys()) {
              const scope = JSON.parse(key).slice(0, -1);
              if (JSON.stringify(scope) === JSON.stringify([namespaceId, ...parts])) {
                entries.delete(key);
              }
            }
          }
        },
        get: (name: string) => snapshots.get(keyFor(name)),
        track(name: string, capture: () => unknown) {
          captures.set(keyFor(name), capture);
          owners.set(keyFor(name), new WeakRef(capture));
        },
        // Records a view's draft again after it was left, as a reply that lands later changes
        // it, unless a newer view tracks the name or it was forgotten (finding 2981).
        record(name: string, capture: () => unknown) {
          const key = keyFor(name);
          if (owners.get(key)?.deref() === capture) {
            snapshot(key, capture);
          }
        },
        // Names which captured values hold unsaved work; by default, every captured value.
        unsavedWhen(name: string, unsaved: (value: unknown) => boolean) {
          unsavedChecks.set(keyFor(name), unsaved);
        },
        forget(name: string) {
          captures.delete(keyFor(name));
          snapshots.delete(keyFor(name));
          unsavedChecks.delete(keyFor(name));
          owners.delete(keyFor(name));
        },
      };
    },
  };
}
