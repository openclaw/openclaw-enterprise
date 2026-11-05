import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const [path, mode] = process.argv.slice(2);
const lifecycleUrl = new URL(
  "../../../apps/controller/src/drivers/repo/github/credentials/prepared-lifecycle.ts",
  import.meta.url,
).href;
const sentinel = new Error("prepared GitHub lifecycle blocked");
let attempts = 0;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url === lifecycleUrl) {
      attempts++;
      if (mode !== "selected") {
        throw sentinel;
      }
    }
    return resolved;
  },
});

// Import must succeed even when the unselected implementation is unavailable.
const { loadInstallationConfiguration } =
  await import("../../../apps/controller/src/composition/installation-config.ts");
const load = () =>
  loadInstallationConfiguration({ mode: "production", environment: { OCC_CONFIG_PATH: path } });
if (mode === "selected-blocked") {
  await assert.rejects(load(), (error: unknown) => error === sentinel);
  assert.equal(attempts, 1);
} else if (mode === "selected") {
  const loaded = await load();
  assert.ok(attempts > 0, "selected startup must import the lifecycle");
  hook.deregister();
  const { PostgresPreparedGitHubLifecycle } = await import(lifecycleUrl);
  assert.ok(loaded?.preparedGitHub);
  assert.ok(loaded.tokenService);
  assert.ok(loaded.preparedGitHub instanceof PostgresPreparedGitHubLifecycle);
  assert.equal(loaded.tokenService.issuer(loaded.preparedGitHub.provider), loaded.preparedGitHub);
} else {
  assert.equal(mode, "native");
  const api = await load();
  const worker = await load();
  const selection = { namespaceId: "ns_repository", bindings: [{ repositoryRef: "application" }] };
  assert.ok(api?.repositoryPolicy);
  assert.ok(worker?.repositoryPolicy);
  const resolved = api.repositoryPolicy.resolve(selection);
  assert.equal(resolved.bindings[0]?.grant.repositoryId, "34567");
  assert.deepEqual(worker.repositoryPolicy.resolve(selection), resolved);
  for (const runtime of [api, worker]) {
    assert.throws(
      () => runtime.repositoryPolicy!.resolve({ ...selection, namespaceId: "ns_other" }),
      /permitted/,
    );
    assert.equal(runtime.preparedGitHub, undefined);
  }
  assert.equal(attempts, 0);
}
hook.deregister();
