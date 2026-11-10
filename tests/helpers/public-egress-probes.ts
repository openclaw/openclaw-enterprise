import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { codexRepositoryEvidenceScript } from "./normal-agent-tools.mjs";
import type { RunWindow } from "./public-egress-deadline.ts";
import type { PublicEgressInputs } from "./public-egress-inputs.ts";
import { onlyReadyPod, runningContainer } from "./public-egress-kubernetes.ts";
import {
  assertPublicNetworkReceipt,
  authenticatedRepositoryProgram,
  publicBootstrapProgram,
  publicCustodyProgram,
  publicGatewayTurnProgram,
  publicNetworkProgram,
  type NetworkReceipt,
} from "./public-egress-programs.ts";
import type { PublicEgressPolicy, PublicEgressRuntime } from "./public-egress-runtime.ts";
import type { PublicEgressEvidence, PublicEgressStack } from "./public-egress-stack.ts";

export const publicEgressWorkspace = "/home/node/workspace";
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

type TurnReceipt = { runId: string; sessionKey: string; status: string; replyMatched: boolean };
type CommandReceipt = {
  status: string;
  commands: { operations: string[]; status: string; exitCode: number | null }[];
};
type BootstrapReceipt = {
  nonce: string;
  initiallyEmpty: boolean;
  executable: string;
  signal: string | null;
  exitCode: number | null;
  version?: string;
  integrityFailure: boolean;
  connectDenied: boolean;
};
type CredentialUse = {
  exchange_id: string;
  operation: string;
  recipient_fence: string;
  expected_principal: boolean;
  current_recipient: boolean;
};
type CustodyReceipt = {
  nativeAuthPresent: boolean;
  nativeAuthOpaque: boolean;
  providerEnvironmentOpaque: boolean;
  refreshMaterialAbsent: boolean;
  privateKeyAbsent: boolean;
};

export function publicEgressProbes({
  stack,
  input,
  runtime,
  policy,
  agentId,
  evidence,
  window,
}: {
  stack: PublicEgressStack;
  input: PublicEgressInputs["input"];
  runtime: PublicEgressRuntime;
  policy: PublicEgressPolicy;
  agentId: string;
  evidence: PublicEgressEvidence;
  window: RunWindow;
}) {
  const { kube, placement, pool } = stack;
  const { save } = evidence;
  const { exec } = kube;
  const workspace = publicEgressWorkspace;
  const command = async (label: string, argv: string[]) => {
    const nonce = "PUBLIC_EGRESS_" + randomUUID();
    const text = argv.map(shellQuote).join(" ");
    const apiPod = onlyReadyPod(
      await kube.pods(input.controllerNamespace, input.controllerSelector),
      "selected controller API",
    );
    runningContainer(apiPod, "api", input.images.controller);
    await save(label + "-intent", {
      revisionId: runtime.revision.id,
      nonce,
      commandSha256: createHash("sha256").update(text).digest("hex"),
    });
    const result: TurnReceipt = JSON.parse(
      await exec(
        apiPod,
        "api",
        ["node", "-e", publicGatewayTurnProgram],
        JSON.stringify({
          namespaceId: input.namespaceId,
          agentId: agentId,
          nonce,
          prompt: `Use the shell tool once, with cwd ${workspace}, to run exactly this command: ${text}\nDo not change or retry it. Reply with ${nonce}.`,
        }),
      ),
    );
    const evidence: CommandReceipt = JSON.parse(
      await exec(runtime.gateway, "gateway", [
        "node",
        "-e",
        codexRepositoryEvidenceScript,
        nonce,
        JSON.stringify([{ operation: label, workdir: workspace, argv }]),
      ]),
    );
    assert.ok(result.runId && result.sessionKey);
    assert.equal(result.status, "ok");
    assert.equal(result.replyMatched, true);
    assert.equal(evidence.status, "completed");
    const matching = evidence.commands.filter((entry) => entry.operations.includes(label));
    assert.equal(matching.length, 1, "exactly one execution of the requested command");
    assert.equal(matching[0]!.status, "completed");
    assert.equal(matching[0]!.exitCode, 0);
    await save(label + "-turn", { result, evidence });
  };
  const bootstrap = async (label: string, allowed: boolean) => {
    const nonce = randomUUID();
    const receipt = "/tmp/package-receipt-" + nonce + ".json";
    const { packageManager }: { packageManager: string } = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), {
        encoding: "utf8",
        signal: window.signal,
      }),
    );
    assert.match(packageManager, /^pnpm@\d+\.\d+\.\d+\+sha512\.[a-f0-9]{128}$/u);
    await command(label, [
      "/usr/local/bin/node",
      "-e",
      `eval(${JSON.stringify(publicBootstrapProgram({ packageManager, receipt, nonce }))})`,
    ]);
    const report: BootstrapReceipt = JSON.parse(
      await exec(runtime.harness, "agent", [
        "node",
        "-e",
        "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'))",
        receipt,
      ]),
    );
    assert.equal(report.nonce, nonce);
    assert.equal(report.initiallyEmpty, true);
    assert.equal(report.executable, "/usr/local/bin/node");
    assert.equal(report.signal, null);
    if (allowed) {
      assert.equal(report.exitCode, 0);
      assert.equal(report.version, packageManager.split("@")[1]?.split("+")[0]);
      assert.equal(report.integrityFailure, false);
    } else {
      assert.notEqual(report.exitCode, 0);
      assert.equal(report.connectDenied, true);
    }
    await save(label + "-receipt", report);
  };
  const uses = async () => {
    window.require(15_000);
    return (
      await pool.query<CredentialUse>(
        `SELECT u.exchange_id, u.operation, u.recipient_fence,
          (a.admission #>> '{grant,appId}' = $5 AND
           a.admission #>> '{grant,installationId}' = $6) AS expected_principal,
          EXISTS (SELECT 1 FROM occ.credential_deliveries d
            JOIN occ.egress_installations e
              ON (e.namespace_id,e.agent_id,e.revision_id)=(d.namespace_id,d.agent_id,d.revision_id)
            WHERE (d.namespace_id,d.agent_id,d.live_revision_id)=($1,$2,$3)
              AND d.fence=u.recipient_fence AND d.preparation_attempt_id=u.attempt_id
              AND d.material_version=u.material_version AND d.blocked IS NULL
              AND d.write_pending IS NULL AND d.settlement='witness'
              AND d.target->>'transport'='registered-repository-git/v1'
              AND d.target->'installation'=e.installation
              AND d.binding_id=e.installation #>> '{plan,execution,executionId}'
              AND e.sandbox_id=$7 AND e.installation #>> '{enforcement,instanceId}'=$8
              AND e.installation #>> '{enforcement,repositoryGitRecipient,networkInstanceId}'=$8
          ) AS current_recipient
        FROM occ.prepared_repository_git_uses u
        JOIN occ.repository_session_attempts s USING (admission_id)
        JOIN occ.prepared_github_attempts a ON a.id=u.attempt_id AND a.material_version=u.material_version
        WHERE s.namespace_id=$1 AND s.agent_id=$2 AND s.live_revision_id=$3 AND s.repository_ref=$4`,
        [
          input.namespaceId,
          agentId,
          runtime.revision.id,
          input.repositoryRef,
          input.expectedGitHubAppId,
          input.expectedGitHubInstallationId,
          policy.sandbox.id,
          policy.mainProcessInstanceId,
        ],
      )
    ).rows;
  };
  const gitReads = async (phase: string) => {
    const prior = new Set((await uses()).map((use) => use.exchange_id));
    await command(phase + "-git", [
      "git",
      "ls-remote",
      "--exit-code",
      "https://github.com/" + input.repository + ".git",
      "HEAD",
    ]);
    const gitUses = (await uses()).filter((use) => !prior.has(use.exchange_id));
    assert.ok(
      gitUses.some(
        (use) =>
          use.operation === "advertise-upload-pack" &&
          use.expected_principal &&
          use.current_recipient,
      ),
      "a new protected Git credential use must accompany the read",
    );
    const beforeApi = new Set((await uses()).map((use) => use.exchange_id));
    const receipt = "/tmp/repository-auth-" + randomUUID() + ".json";
    await command(phase + "-gh", [
      "/usr/local/bin/node",
      "-e",
      `eval(${JSON.stringify(authenticatedRepositoryProgram({ repository: input.repository, permissions: input.repositoryPermissions, receipt }))})`,
    ]);
    const auth: { authenticatedPermissions: boolean } = JSON.parse(
      await exec(runtime.harness, "agent", ["cat", receipt]),
    );
    assert.equal(
      auth.authenticatedPermissions,
      true,
      "anonymous public metadata is not authenticated GitHub evidence",
    );
    const apiUses = (await uses()).filter((use) => !beforeApi.has(use.exchange_id));
    assert.ok(
      apiUses.some(
        (use) =>
          use.operation === "github-rest" &&
          Number(use.recipient_fence) > 0 &&
          use.expected_principal &&
          use.current_recipient,
      ),
      "the authenticated read must create a new protected API credential use",
    );
    await save(phase + "-credential-use", { gitUses, apiUses, auth });
  };
  const custody = async (phase: string) => {
    const pods = await kube.pods(placement, "openclaw.dev/agent=" + agentId);
    assert.ok(pods.some((pod) => pod.metadata.uid === runtime.harness.metadata.uid));
    const noCustodySecretReferences = pods.every((pod) =>
      input.custodySecretNames.every(
        (name) => !JSON.stringify(pod.spec).includes(JSON.stringify(name)),
      ),
    );
    assert.equal(
      noCustodySecretReferences,
      true,
      "Agent Pods must not reference model/App/custody Secrets",
    );
    const report: CustodyReceipt = JSON.parse(
      await exec(runtime.harness, "agent", ["node", "-e", publicCustodyProgram]),
    );
    assert.equal(report.nativeAuthPresent, true);
    assert.equal(report.nativeAuthOpaque, true);
    assert.equal(report.providerEnvironmentOpaque, true);
    assert.equal(report.refreshMaterialAbsent, true);
    assert.equal(report.privateKeyAbsent, true);
    await save(phase + "-custody", {
      noCustodySecretReferences,
      nativeAuthPresent: report.nativeAuthPresent,
      nativeAuthOpaque: report.nativeAuthOpaque,
      providerEnvironmentOpaque: report.providerEnvironmentOpaque,
      refreshMaterialAbsent: report.refreshMaterialAbsent,
      privateKeyAbsent: report.privateKeyAbsent,
    });
  };
  const network = async (phase: string, allowed: boolean, hosts: string[]) => {
    const nonce = randomUUID();
    const receipt = "/tmp/public-network-" + nonce + ".json";
    await command(phase + "-network", [
      "/usr/local/bin/node",
      "-e",
      `eval(${JSON.stringify(publicNetworkProgram({ nonce, receipt, publicTcp: input.publicTcp, managedHosts: hosts }))})`,
    ]);
    const report: NetworkReceipt = JSON.parse(
      await exec(runtime.harness, "agent", ["cat", receipt]),
    );
    assertPublicNetworkReceipt(report, { nonce, allowed, hosts, publicTcp: input.publicTcp });
    await save(phase + "-network", report);
  };
  return { bootstrap, gitReads, custody, network };
}
