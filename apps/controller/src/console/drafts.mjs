// Drafts live only in this document. Editors explicitly select non-credential state.
const captured = (value) => value !== undefined;

export function createDraftStore() {
  const snapshots = new Map();
  const captures = new Map();
  const unsavedChecks = new Map();
  const isUnsaved = (key, value) => (unsavedChecks.get(key) ?? captured)(value);
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
    retainNamespaces(namespaceIds) {
      const kept = new Set(namespaceIds);
      for (const entries of [captures, snapshots, unsavedChecks]) {
        for (const key of entries.keys()) {
          if (!kept.has(JSON.parse(key)[0])) {
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
    scope(...parts) {
      const keyFor = (name) => JSON.stringify([...parts, name]);
      return {
        get: (name) => snapshots.get(keyFor(name)),
        track(name, capture) {
          captures.set(keyFor(name), capture);
        },
        // Names which captured values hold unsaved work; by default, every captured value.
        unsavedWhen(name, unsaved) {
          unsavedChecks.set(keyFor(name), unsaved);
        },
        forget(name) {
          captures.delete(keyFor(name));
          snapshots.delete(keyFor(name));
          unsavedChecks.delete(keyFor(name));
        },
      };
    },
  };
}
