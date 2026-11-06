import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "./console-app.mjs";

function assertReadyController(fixture: {
  readonly controller: unknown;
}): asserts fixture is { readonly controller: OpenClawController } {
  assert.ok(fixture.controller instanceof OpenClawController);
}

// A console app with a bootstrapped administrator and one ready Namespace. The options go to
// createConsoleAppFixture unchanged, so a suite that needs default Presets passes them there:
// { defaultPresets: [preset] }.
export async function createReadyConsoleNamespace<Options extends object>(
  t: TestContext,
  name: string,
  options?: Options & NonNullable<Parameters<typeof createConsoleAppFixture>[1]>,
) {
  // Replace the legacy getter's inferred any before narrowing the original fixture.
  const fixture: Omit<Awaited<ReturnType<typeof createConsoleAppFixture>>, "controller"> & {
    readonly controller: unknown;
  } = await createConsoleAppFixture(t, options);
  await fixture.bootstrap();
  assertReadyController(fixture);
  const namespace = await fixture.createNamespace(name, { ready: true });
  return { fixture, namespace };
}
