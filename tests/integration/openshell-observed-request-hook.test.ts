import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  assertExecutionAdmission,
  validRepositoryGitRecipient,
  type AgentRevision,
  type ProxyRevisionContext,
  type RepositoryGitRecipient,
} from "../../packages/contracts/src/index.ts";
import { ObservedHookPreview } from "../../apps/controller/src/drivers/egress-proxy/openshell-request-hook-preview.ts";
import type { OpenShellOnlineHttpRequest } from "../../apps/controller/src/drivers/egress-proxy/openshell-online-authority.ts";
import type { OpenShellPreparedGitInstalled } from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";

const mode = "request-hook-observed";
const workspace = "isolated-team";
const sandboxId = randomUUID();
const bindingId = randomUUID();

test("a per-start denial joins the authenticated request to the refusal actually returned; neither side can substitute", () => {
  const preview = new ObservedHookPreview(workspace, bindingId);
  const startupId = randomUUID();
  assert.throws(() => preview.arm(startupId), /not fresh/);
  preview.recipient = "fixture-observed-recipient";
  preview.bootstrapRevision = "72";
  const probePath = preview.arm(startupId);
  const target = {
    reportedScheme: "https",
    host: "github.com",
    port: 443,
    method: "GET",
    path: probePath,
    query: "service=git-upload-pack",
  } as const;
  const request: OpenShellOnlineHttpRequest = {
    workspace,
    bindingId,
    sandboxId,
    requestId: randomUUID(),
    target,
    headers: [],
    body: new Uint8Array(),
    deadlineAt: new Date(Date.now() + 5000).toISOString(),
  };
  // Response-only, a generic origin 403, and a response copied from a different startup cannot qualify.
  const wrong = { startupId, probePath, reasonCode: "oce_hook_" + "f".repeat(36) };
  assert.throws(() => preview.confirm(wrong), /did not receive its exact/);
  for (const other of [
    { ...request, sandboxId: "wrong" },
    { ...request, workspace: "wrong" },
    { ...request, bindingId: "wrong" },
    { ...request, target: { ...target, path: target.path + "wrong" } },
    { ...request, headers: [["authorization", "no credential belongs here"]] as const },
  ]) {
    assert.equal(preview.deny(other, sandboxId), undefined);
  }
  const reasonCode = preview.deny(request, sandboxId);
  assert.match(reasonCode!, /^oce_hook_[0-9a-f]{36}$/);
  assert.equal(
    preview.deny(request, sandboxId),
    undefined,
    "the same challenge cannot be consumed twice",
  );
  assert.throws(() => preview.confirm(wrong), /did not receive its exact/);
  assert.throws(() => preview.confirm({ ...wrong, reasonCode, startupId: randomUUID() }), /exact/);
  preview.confirm({ startupId, probePath, reasonCode });
  assert.equal(preview.hook!.startupId, startupId);
  assert.throws(() => preview.arm(startupId), /not fresh/);

  const context = {
    plan: { execution: { executionId: bindingId }, repositoryGitAuthorization: mode },
  } as ProxyRevisionContext;
  const observed = {
    workspace,
    observedHook: preview.hook,
    providerId: "provider",
    attachmentEpoch: "attached",
    processInstanceId: "process",
    networkInstanceId: "network",
    policyHash: "policy",
  } as OpenShellPreparedGitInstalled;
  assert.equal(preview.enforcement(context, { ...observed, workspace: "other" }), undefined);
  assert.equal(
    preview.enforcement(context, {
      ...observed,
      observedHook: { startupId, observationId: "other" },
    }),
    undefined,
  );
  const recipient = preview.enforcement(context, observed)!.repositoryGitRecipient!;
  assert.equal(validRepositoryGitRecipient(recipient, "github_installation", mode), true);
  assert.equal(
    validRepositoryGitRecipient(recipient, "github_installation", "online-request"),
    false,
  );
  assert.equal(validRepositoryGitRecipient(recipient, "github_installation"), false);
  assert.equal(validRepositoryGitRecipient(recipient, "repository_git", mode), false);
  const { observedHook: _, ...incomplete } = recipient;
  assert.equal(
    validRepositoryGitRecipient(incomplete as RepositoryGitRecipient, "github_installation", mode),
    false,
  );
});

test("observed-hook preview has its own durable admission and cannot reinterpret v4, v5, or narrow Git", () => {
  const driver = { id: "fixture", implementation: "openshell", configurationId: "f".repeat(64) };
  const revision = (
    version: number,
    authorization: string | undefined,
    profile = "github-installation",
  ) =>
    ({
      executionAdmission: { version, mode: "protected" },
      egressPlan: {
        routes: [],
        driver,
        repositoryGit: { bindings: [{ profile }] },
        ...(authorization && { repositoryGitAuthorization: authorization }),
      },
    }) as unknown as Pick<AgentRevision, "executionAdmission" | "egressPlan">;
  assert.doesNotThrow(() => assertExecutionAdmission(revision(6, mode)));
  assert.doesNotThrow(() => assertExecutionAdmission(revision(5, "online-request")));
  assert.doesNotThrow(() => assertExecutionAdmission(revision(4, undefined)));
  for (const r of [
    revision(5, mode),
    revision(4, mode),
    revision(6, undefined),
    revision(6, "online-request"),
    revision(6, mode, "git-write"),
  ]) {
    assert.throws(
      () => assertExecutionAdmission(r),
      /requires its own protected execution admission/,
    );
  }
});
