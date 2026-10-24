// Sets entries of this process's environment for one test or one call and puts back
// what each entry held before: its old value, or unset again when it was unset. A value
// of `undefined` unsets the entry for that time.

const restores = new WeakMap();

// Sets `values` in process.env until the test that owns `t` ends. All calls for one test
// are undone together, at the point where the first call registered its `t.after` hook,
// and in reverse order, so an entry set twice ends as it was before the first call.
export function setEnvironment(t, values) {
  let stack = restores.get(t);
  if (stack === undefined) {
    stack = [];
    restores.set(t, stack);
    t.after(() => {
      while (stack.length > 0) {
        stack.pop()();
      }
    });
  }
  stack.push(assignEnvironment(values));
}

// Runs `body` with `values` set in process.env and restores them when it settles.
export async function withEnvironment(values, body) {
  const restore = assignEnvironment(values);
  try {
    return await body();
  } finally {
    restore();
  }
}

function assignEnvironment(values) {
  const previous = Object.keys(values).map((name) => [name, process.env[name]]);
  for (const [name, value] of Object.entries(values)) {
    setEntry(name, value);
  }
  return () => {
    for (const [name, value] of previous) {
      setEntry(name, value);
    }
  };
}

function setEntry(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
