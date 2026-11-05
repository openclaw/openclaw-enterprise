import { after } from "node:test";

import type { createConsoleAppFixture } from "./console-app.mjs";

type ConsoleAppFixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type SharedConsoleAppFixture = ConsoleAppFixture & { sharedByFile: true };
type Cleanup = () => void | Promise<void>;

export interface CleanupRegistrar {
  after(cleanup: Cleanup): void;
}

// Restore own enumerable policy arrays in place so existing IAM readers keep their references.
function restorePolicy<Policy extends Record<keyof Policy, unknown[]>>(
  target: Policy,
  original: Policy,
): void {
  const snapshot = structuredClone(original);
  for (const key in snapshot) {
    if (Object.hasOwn(snapshot, key)) {
      target[key].splice(0, Infinity, ...snapshot[key]);
    }
  }
}

export function fileConsoleApp(
  createFixture: (registrar: CleanupRegistrar) => Promise<ConsoleAppFixture>,
) {
  const cleanups: Cleanup[] = [];
  let created:
    | Promise<{
        fixture: SharedConsoleAppFixture;
        startPolicy: ConsoleAppFixture["policy"];
      }>
    | undefined;

  after(async () => {
    await created?.catch(() => {});
    let cleanupError: unknown;
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    // Preserve the existing nullish accumulation and truthy rethrow semantics.
    if (cleanupError) {
      throw cleanupError;
    }
  });

  return async function fileApp(t: CleanupRegistrar): Promise<SharedConsoleAppFixture> {
    if (created === undefined) {
      const creating = (async () => {
        const fixture = await createFixture({
          after: (cleanup) => {
            cleanups.push(cleanup);
          },
        });
        await fixture.bootstrap();
        // Mutate the original object: spreading would snapshot its live controller getter.
        const shared = Object.assign(fixture, { sharedByFile: true as const });
        return { fixture: shared, startPolicy: structuredClone(fixture.policy) };
      })();
      // Keep partial-start cleanup registered for file teardown, and allow the next call to retry.
      creating.catch(() => {
        if (created === creating) {
          created = undefined;
        }
      });
      created = creating;
    }
    const { fixture, startPolicy } = await created;
    const restore = () => restorePolicy(fixture.policy, startPolicy);
    restore();
    t.after(restore);
    return fixture;
  };
}
