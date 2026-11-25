import assert from "node:assert/strict";
import test from "node:test";
import { fixture, codexAppServer } from "./repository-runtime-material-fixture.ts";
import { preparedCodexManifest } from "./repository-runtime-material-observations.ts";
import {
  publicReader,
  publicReaderPolicies,
} from "./repository-runtime-material-public-reader-fixture.ts";

test("enabling the reader cannot grant an already admitted revision during activation or repair", async () => {
  const f = await fixture("dedicated");
  delete f.revision.repositoryCredentials;
  codexAppServer(f.revision.configuration).networkProxy = {
    enabled: true,
    domains: { [publicReader.address]: "allow" },
  };
  const context = f.context(undefined);
  await f.driver.prepareRevision(f.revision, context);
  f.markReady();
  await f.driver.activateRevision(f.revision, context);

  // The serialized revision predates the operator enabling the service.
  const oldRevision = structuredClone(f.revision);
  f.ports.options.network.publicGithubRead = publicReader;
  await f.driver.prepareRevision(oldRevision, context);
  await f.driver.activateRevision(oldRevision, context);
  assert.equal(publicReaderPolicies(f).length, 0);
  assert.equal(preparedCodexManifest(f).publicGithubRead, undefined);

  // Reconstructing a lost immutable projection must retain the old decision.
  for (const [key, object] of f.objects) {
    if (object.kind === "ConfigMap" && object.data?.["runtime.json"]) {
      f.objects.delete(key);
    }
  }
  await f.driver.prepareRevision(oldRevision, context);
  assert.equal(preparedCodexManifest(f).publicGithubRead, undefined);
  assert.equal(publicReaderPolicies(f).length, 0);
});
