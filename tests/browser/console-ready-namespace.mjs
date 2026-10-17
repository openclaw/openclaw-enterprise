import { createConsoleAppFixture } from "../helpers/console-app.mjs";

export async function createReadyConsoleNamespace(t, name, options) {
  const fixture = await createConsoleAppFixture(t, options);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(name, { ready: true });
  return { fixture, namespace };
}
