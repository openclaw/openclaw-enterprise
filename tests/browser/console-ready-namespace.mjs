import { createConsoleAppFixture } from "../helpers/console-app.mjs";

export async function createReadyConsoleNamespace(t, name, options) {
  const fixture = await createConsoleAppFixture(t, options);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(name, { ready: true });
  return { fixture, namespace };
}

// createReadyConsoleNamespace for a file app (fileConsoleApp): a test that passes no fixture
// options makes its ready Namespace in the file's app, one that passes options gets an app of
// its own. The Namespace name must be one no other test in the file uses.
export function fileReadyNamespace(fileApp) {
  return async (t, name, options) => {
    if (options !== undefined) {
      return createReadyConsoleNamespace(t, name, options);
    }
    const fixture = await fileApp(t);
    const namespace = await fixture.createNamespace(name, { ready: true });
    return { fixture, namespace };
  };
}
