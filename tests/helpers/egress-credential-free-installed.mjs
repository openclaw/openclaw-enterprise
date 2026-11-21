import assert from "node:assert/strict";
import { credentialFreeRepository as repository } from "../fixtures/egress-custody-repository-origin.mjs";
import { sourceAccessBindingBody } from "./egress-connected-inputs.mjs";
import { activateRepositoryAgent } from "./egress-custody-installed-agent.mjs";
import {
  agentClients,
  assertIdentityResponse,
  receipts,
  refusal,
} from "./egress-custody-observations.mjs";

// Use the same owned Agent, but a fresh source, grant, revision, enrollment and response sink.
// The last-binding withdrawal currently retires its Sandbox. Observe denial while the recipient
// is still live, then observe actual route withdrawal and retirement, without racing a dying Pod.
export async function verifyCredentialFreeReadAndWithdrawal({
  setup,
  stack,
  evidence,
  owned,
  admitted,
}) {
  const { agent, role, route } = admitted;
  const { api, checkpoint, runId } = evidence;
  const { create, provider } = owned;
  const { f } = setup;
  const { namespacePath, placement, pool } = stack;
  const source = await create("credential-sources", {
    name: "identity-only-" + runId,
    type: "credential-free-repository-metadata",
    config: {
      agent_id: agent.id,
      authority: "execution",
      origin: provider.businessOrigin,
      repository_id: String(repository.id),
      repository: repository.full_name,
    },
  });
  assert.equal(source.egress.adoption, "credential_free");
  assert.deepEqual(source.secrets, {});
  const configured = (
    await pool.query(
      `
    SELECT EXISTS (SELECT FROM occ.credential_source_secrets WHERE credential_source_id=$1) AS secret,
           EXISTS (SELECT FROM occ.prepared_github_families WHERE source_id=$1) AS family`,
      [source.id],
    )
  ).rows;
  assert.deepEqual(
    configured,
    [{ secret: false, family: false }],
    "no Secret binding or prepared family to read",
  );
  await api("PATCH", route, {
    configurationId: agent.configurationId,
    harnessAuth: { method: "runtime" },
    credentialSources: [{ sourceId: source.id }],
  });
  const binding = await create("iam/access-bindings", sourceAccessBindingBody(agent, role, source));
  const installed = await activateRepositoryAgent(setup, stack, evidence, owned, {
    ...admitted,
    source,
    binding,
  });
  const { custodyTransitions: custody } = installed;
  const rows = () => receipts(pool, installed.installation, "no_material_required");
  const { curl } = agentClients(
    installed,
    provider.businessOrigin,
    "/repos/" + repository.full_name,
  );
  const reads = provider.observations.length;
  const issues = provider.issues;
  const before = await custody.snapshot();
  const preparse = provider.wireRequests;
  assert.deepEqual(await rows(), [], "newly enrolled recipient");
  assertIdentityResponse(await curl(), repository);
  const id = await custody.expectAfter(before, [
    "resolve_no_material_accepted",
    "permit_no_material_accepted",
    "response_released",
  ]);
  const selected = await rows();
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, id);
  assert.equal(
    selected[0].exact,
    true,
    "actual no-material binding, empty injection digest, same execution, installation and unique custody",
  );
  assert.equal(selected[0].observation.kind, "response");
  const [read, ...extra] = provider.observations.slice(reads);
  assert.ok(
    read.exactCredentialFreeRead && read.finished,
    "exact bodyless credential-free request at the origin",
  );
  assert.deepEqual(extra, []);
  assert.equal(
    provider.wireRequests,
    preparse + 1,
    "one credential-free request at pre-parse origin",
  );
  assert.equal(provider.issues, issues, "no new provider credential issued");
  await checkpoint("explicit-credential-free-repository-read", {
    requestId: id,
    accessPermits: 1,
    secretBindings: 0,
    preparedFamilies: 0,
    sendPermits: 1,
    credentialFreeOriginReads: 1,
  });

  // The positive control above proves that this actual recipient can receive the provider response.
  const resolved = await custody.snapshot();
  await api("DELETE", namespacePath + "/iam/access-bindings/" + binding.id, undefined, 204);
  assert.ok(
    (await curl()) === refusal,
    "withdrawing the last authorization gives the fixed local denial only",
  );
  const deniedId = await custody.expectAfter(resolved, [
    "resolve_refused",
    "no_permit",
    "response_blocked",
  ]);
  assert.notEqual(deniedId, id);
  assert.deepEqual(await rows(), selected, "no dispatch reserved on refusal");
  assert.equal(
    provider.wireRequests,
    preparse + 1,
    "refusal sent no request to the pre-parse origin",
  );
  const sourceRoute = route + "/credential-sources/" + source.id;
  await api("POST", sourceRoute + "/withdraw", undefined, 202);
  await f.waitFor(
    "actual final credential-free route withdrawal",
    async () => {
      const withdrawal = await api("GET", sourceRoute + "/withdrawal");
      return (
        withdrawal.revisionId === installed.revision.id &&
        withdrawal.state === "revoked" &&
        !!withdrawal.completedAt
      );
    },
    180_000,
  );
  await f.waitFor(
    "old credential-free recipient retired",
    async () => {
      const pods = await f.resources("pods", placement);
      return !pods.some(
        (p) => p.metadata.labels?.["openshell.ai/sandbox-id"] === installed.installation.sandboxId,
      );
    },
    180_000,
  );
  assert.deepEqual(await rows(), selected, "no dispatch or replay after final route retirement");
  assert.equal(
    provider.observations.length,
    reads + 1,
    "only the positive control reached the provider",
  );
  await checkpoint("credential-free-last-authority-and-route-withdrawn", {
    deniedRequestId: deniedId,
    additionalOriginReads: 0,
    additionalDispatches: 0,
    finalRouteWithdrawn: true,
  });
}
