import type { TestContext } from "node:test";
import { createConsoleAppFixture } from "./console-app.mjs";

// A console app with a bootstrapped administrator and one ready Namespace. The options go to
// createConsoleAppFixture unchanged, so a suite that needs default Presets passes them there:
// { defaultPresets: [preset] }.
export async function createReadyConsoleNamespace<Options extends object>(
  t: TestContext,
  name: string,
  options?: Options & NonNullable<Parameters<typeof createConsoleAppFixture>[1]>,
) {
  const fixture = await createConsoleAppFixture(t, options);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(name, { ready: true });
  return { fixture, namespace };
}
