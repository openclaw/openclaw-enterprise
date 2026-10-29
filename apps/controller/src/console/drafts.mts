// Drafts live only in this document. Editors explicitly select non-credential state.
const captured = (value: unknown): boolean => value !== undefined;

export function createDraftStore() {
  const snapshots = new Map<string, unknown>();
  const captures = new Map<string, () => unknown>();
  const unsavedChecks = new Map<string, typeof captured>();
  const isUnsaved = (key: string, value: unknown) => (unsavedChecks.get(key) ?? captured)(value);
  return {
    flush() {
      for (const [key, capture] of captures) {
        const value = capture();
        if (value === undefined) {
          snapshots.delete(key);
        } else {
          snapshots.set(key, value);
        }
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
    },
    // Forgets the drafts of every Namespace a successful read no longer lists. Each key's first
    // part names its Namespace (see scope).
    retainNamespaces(namespaceIds: Iterable<string>) {
      const kept = new Set<string | null>(namespaceIds);
      for (const entries of [captures, snapshots, unsavedChecks]) {
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
          for (const entries of [captures, snapshots, unsavedChecks]) {
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
        },
        // Names which captured values hold unsaved work; by default, every captured value.
        unsavedWhen(name: string, unsaved: (value: unknown) => boolean) {
          unsavedChecks.set(keyFor(name), unsaved);
        },
        forget(name: string) {
          captures.delete(keyFor(name));
          snapshots.delete(keyFor(name));
          unsavedChecks.delete(keyFor(name));
        },
      };
    },
  };
}
