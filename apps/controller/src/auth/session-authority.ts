/** Serializes a session's policy writes with local logout through their completion. */
export function sessionAuthority() {
  const pending = new Map<string, Promise<void>>();
  return async function withSessionAuthority<T>(
    sessionId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = pending.get(sessionId);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    pending.set(sessionId, held);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (pending.get(sessionId) === held) {
        pending.delete(sessionId);
      }
    }
  };
}
