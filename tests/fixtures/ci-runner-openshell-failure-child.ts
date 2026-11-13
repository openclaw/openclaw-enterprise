import assert from "node:assert/strict";
import { readFileSync, watch, writeFileSync } from "node:fs";
import test from "node:test";

const repositoryUrl = readFileSync(new URL("repository-url", import.meta.url), "utf8");
const { runOpenShellStage }: typeof import("../helpers/openshell-stage.mjs") = await import(
  new URL("tests/helpers/openshell-stage.mjs", repositoryUrl).href
);
const { boundedTeardown }: typeof import("../helpers/bounded-teardown.ts") = await import(
  new URL("tests/helpers/bounded-teardown.ts", repositoryUrl).href
);
const { openShellProgressPrefix }: typeof import("../../scripts/ci/openshell-progress.mjs") =
  await import(new URL("scripts/ci/openshell-progress.mjs", repositoryUrl).href);

test("original failure", async (t) => {
  const { context } = boundedTeardown(t);
  context.after(
    () =>
      new Promise<void>((resolve) => {
        const watcher = watch(process.cwd(), (_event, name) => {
          if (name === "release") {
            watcher.close();
            resolve();
          }
        });
        writeFileSync("cleanup-ready", "ready");
      }),
  );
  const canary = "generated-credential-must-stay-private";
  const record = {
    kind: "openshell-stage-failure",
    stage: "installation",
    category: "Error",
    code: null,
    location: "tests/helpers/openshell-sandbox-workflows.mjs",
  };
  for (const change of [
    { category: canary },
    { code: canary },
    { location: canary },
    { stage: canary },
    { detail: canary },
  ]) {
    process.stdout.write(openShellProgressPrefix + JSON.stringify({ ...record, ...change }) + "\n");
  }
  assert.equal(await runOpenShellStage(t, "installation", async () => 42, "installation"), 42);

  // A real source path embedded in a message or custom stack cannot set provenance.
  const reporterUrl = new URL("scripts/ci/reporter.mjs", repositoryUrl).href;
  const spoof = Object.assign(new Error(canary + "\n    at " + reporterUrl + ":999999:123456"), {
    code: "ETIMEDOUT",
  });
  spoof.stack = spoof.message;
  let accessed = 0;
  const getter = () => {
    accessed++;
    throw new Error(canary);
  };
  const unreadableName = new Error(canary);
  Object.defineProperties(unreadableName, {
    name: { get: getter },
    stack: { get: getter },
    code: { value: "ENOENT" },
  });
  const unreadableCode = new Error(canary);
  Object.defineProperties(unreadableCode, {
    name: { value: "RangeError" },
    stack: { get: getter },
    code: { get: getter },
  });
  const opaque = new Proxy(new Error(canary), { get: getter, getOwnPropertyDescriptor: getter });
  const opaquePrototype = new Error(canary);
  Object.setPrototypeOf(opaquePrototype, new Proxy({}, { get: getter, getPrototypeOf: getter }));
  for (const error of [
    spoof,
    unreadableName,
    unreadableCode,
    opaque,
    new TypeError(canary),
    new RangeError(canary),
    opaquePrototype,
  ]) {
    let caught: unknown;
    try {
      await runOpenShellStage(t, "installation", async () => {
        throw error;
      });
    } catch (actual) {
      caught = actual;
    }
    assert.equal(caught, error);
  }
  assert.equal(accessed, 0, "diagnostics must not invoke error accessors or proxy traps");
  let original: unknown;
  await assert.rejects(
    runOpenShellStage(
      t,
      "installation",
      async () => {
        try {
          assert.fail("original-stage-failure");
        } catch (error) {
          original = error;
          throw error;
        }
      },
      "installation",
    ),
    (error: unknown) => error === original,
  );
  writeFileSync("identity-verified", "original-error-identity-verified");
  throw original;
});
