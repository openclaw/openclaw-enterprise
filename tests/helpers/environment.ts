// Sets entries of this process's environment for one test or one call and puts back
// what each entry held before: its old value, or unset again when it was unset. A value
// of `undefined` unsets the entry for that time.

import type { TestContext } from "node:test";

const restores = new WeakMap<TestContext, Array<() => void>>();

// Sets `values` in process.env until the test that owns `t` ends. All calls for one test
// are undone together, at the point where the first call registered its `t.after` hook,
// and in reverse order, so an entry set twice ends as it was before the first call.
export function setEnvironment(t: TestContext, values: Record<string, string | undefined>) {
  let stack = restores.get(t);
  if (stack === undefined) {
    const testStack: Array<() => void> = [];
    stack = testStack;
    restores.set(t, testStack);
    t.after(() => {
      let restore: (() => void) | undefined;
      while ((restore = testStack.pop()) !== undefined) {
        restore();
      }
    });
  }
  stack.push(assignEnvironment(values));
}

// Runs `body` with `values` set in process.env and restores them when it settles.
export async function withEnvironment<T>(
  values: Record<string, string | undefined>,
  body: () => T | PromiseLike<T>,
): Promise<Awaited<T>> {
  const restore = assignEnvironment(values);
  try {
    return await body();
  } finally {
    restore();
  }
}

function assignEnvironment(values: Record<string, string | undefined>) {
  const previous: Array<[string, string | undefined]> = Object.keys(values).map((name) => [
    name,
    process.env[name],
  ]);
  for (const [name, value] of Object.entries(values)) {
    setEntry(name, value);
  }
  return () => {
    for (const [name, value] of previous) {
      setEntry(name, value);
    }
  };
}

function setEntry(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

// Test command fixtures inherit tool paths and selected inputs, not shell startup
// code or options that can run before the fixture's first instruction.
export function withoutShellStartup(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  delete result.BASH_ENV;
  delete result.ENV;
  delete result.SHELLOPTS;
  delete result.BASHOPTS;
  return result;
}
