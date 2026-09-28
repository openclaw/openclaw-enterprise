// Drafts live only in this document. Editors explicitly select non-credential state.
export function createDraftStore() {
  const snapshots = new Map();
  const captures = new Map();
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
    },
    scope(...parts) {
      const keyFor = (name) => JSON.stringify([...parts, name]);
      return {
        get: (name) => snapshots.get(keyFor(name)),
        track(name, capture) {
          captures.set(keyFor(name), capture);
        },
        forget(name) {
          captures.delete(keyFor(name));
          snapshots.delete(keyFor(name));
        },
      };
    },
  };
}
