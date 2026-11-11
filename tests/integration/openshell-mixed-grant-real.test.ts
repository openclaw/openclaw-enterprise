import assert, { AssertionError } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  openShellGitRetentionKind,
  emitOpenShellGitRetention,
} from "../../scripts/ci/openshell-git-retention.mjs";
import { mixedGrantDeploymentCode } from "../helpers/openshell-mixed-grant-setup.ts";
import { FixtureCommandTimeoutError } from "../fixtures/repository-credentials/process.mjs";

import { createManagedWorkloadExec } from "../helpers/egress-managed-workload-exec.mjs";
import { observeUntil } from "../helpers/finite-git-agent.ts";
import { createOpenShellGitDenial } from "../helpers/openshell-git-denial.mjs";
import { createOpenShellGitInstallation } from "../helpers/openshell-git-installation.mjs";
import {
  assertOpenShellModelTurn,
  assertOpenShellToolTurn,
} from "../helpers/openshell-model-turn.ts";

const selected = process.env.OCC_TEST_OPENSHELL_MIXED_GRANT_REAL === "1";
process.env.OCC_TEST_LOCAL_FIRST_AGENT_SANDBOX_DRIVER = "openshell";
process.env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROL_PLANE = "kubernetes";

test(
  "OpenShell grants model and Git on demand and preserves the conversation after Git withdrawal",
  { skip: !selected, timeout: 45 * 60_000 },
  async (t) => {
    let phase = "installation";
    try {
      // Only the upstream model and Git issuer are controlled. Admission, signed
      // grants, workload execution and withdrawal use the installed platform.
      const fixture = await createOpenShellGitInstallation(t, { mode: "mixed-grant" });
      assert.ok(fixture.deployMixedGrantAgent);
      phase = "deployment";
      const a = await fixture.deployMixedGrantAgent();
      const { origin, gitScope, modelOrigin } = fixture;
      assert.ok(gitScope);
      assert.ok(modelOrigin);
      phase = "Gateway assertion profiles";
      for (const provider of [a.modelProvider, a.gitProvider]) {
        const credentials = provider.profile.definition?.credentials;
        assert.ok(Array.isArray(credentials));
        assert.equal(credentials.length, 1);
        const grant = credentials[0]?.token_grant;
        // Wire grant type 3 selects the supplier's Gateway-signed assertion.
        assert.equal(grant?.grant_type, 3);
        assert.ok(grant.cache_ttl);
        assert.equal(Number(grant.cache_ttl.seconds ?? 0), 0);
        assert.equal(Number(grant.cache_ttl.nanos ?? 0), 0);
      }
      const execute = createManagedWorkloadExec(t, {
        backend: fixture.gatewayBackend,
        gatewayClient: fixture.gatewayClient,
        workspace: fixture.workspace,
        checkpoint: fixture.checkpoint,
      });
      const sessionKey = `agent:main:mixed-grant-${randomUUID()}`;
      const sameExecution = async () => {
        assert.deepEqual((await a.readExecution()).identity, a.original.identity);
        const agent = await fixture.request("GET", a.path);
        assert.equal(agent.activeRevisionId, a.revision.id);
      };
      const run = async (command: string[]) =>
        (await execute(a.target, command)).stdout.toString("utf8");
      const directory = `/sandbox/enterprise/mixed-grant-${randomUUID()}`;
      await run(["git", "init", "--quiet", directory]);
      const absent = async (sha: string) => {
        assert.match(sha, /^[a-f0-9]{40}$/u);
        const present = await run([
          "sh",
          "-ceu",
          'git -C "$1" rev-parse --git-dir >/dev/null; if git -C "$1" cat-file -e "$2^{commit}" 2>/dev/null; then printf present; else printf absent; fi',
          "git-object",
          directory,
          sha,
        ]);
        assert.equal(present, "absent", "the workload must not already have the published commit");
      };
      const fetch = async (sha: string, expectedExit: 0 | 128) => {
        // The native Agent launches stock Git through its model tool protocol,
        // inheriting the production launcher configuration. Only its actual exit
        // code and a fixed diagnostic category leave the workload.
        const command = [
          "sh",
          "-ceu",
          'export LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0; set +e; git -C "$1" -c protocol.version=2 fetch --no-tags "$2" "$3" >"$1/fetch.stdout" 2>"$1/fetch.stderr"; status=$?; set -e; case "$(cat "$1/fetch.stderr")" in *"returned error: 403"*|*"response 403"*) category=http403 ;; *) category=other ;; esac; printf "%s" "$category" >"$1/fetch.category"; printf "%s" "$status"',
          "git-fetch",
          directory,
          `https://github.com/${origin.repository}.git`,
          sha,
        ]
          .map((argument) => `'${argument.replaceAll("'", "'\\''")}'`)
          .join(" ");
        const turn = {
          id: `git-${randomUUID()}`,
          harness: "codex" as const,
          marker: `OCE-MODEL-git-fetch-${randomUUID()}`,
          answer: `OCE-MODEL-git-complete-${randomUUID()}`,
          command,
          expectedOutput: String(expectedExit),
          timeoutMs: 120_000,
        };
        modelOrigin.addToolTurn(turn);
        const receipt = await assertOpenShellToolTurn({
          ...a.modelTurnOptions,
          sessionKey,
          turn,
          readOriginToolTurn: modelOrigin.readOriginToolTurn,
          signal: t.signal,
        });
        assert.equal(receipt.sessionKey, sessionKey);
        assert.equal(receipt.origin.commandCount, 1);
        const category = await run(["cat", `${directory}/fetch.category`]);
        assert.match(category, /^(http403|other)$/u);
        await fixture.checkpoint("mixed-grant-agent-git-tool", {
          revisionId: a.revision.id,
          turnId: receipt.turnId,
          sha,
          exitCode: expectedExit,
          commandCount: receipt.origin.commandCount,
        });
        return { category };
      };

      phase = "model before Git";
      assert.equal((await origin.snapshot()).issued, 0, "admission must not mint a Git credential");
      assert.equal((await origin.gitRequests()).length, 0);
      const modelBindingId = a.modelAdmission.route.bindingId;
      assert.ok(modelBindingId);
      const readModelGrantApprovals = fixture.readModelGrantApprovals;
      assert.ok(readModelGrantApprovals);
      // A correct upstream bearer alone could be left over from startup. Require
      // this turn to claim a fresh Gateway assertion for its admitted binding.
      const before = await assertOpenShellModelTurn({
        ...a.modelTurnOptions,
        sessionKey,
        turn: a.modelTurns.before,
        grantEvidence: {
          expected: {
            providerId: a.modelProvider.id,
            credentialKey: "access_token",
            sandboxId: a.target.sandboxId,
            bindingId: modelBindingId,
            namespaceId: a.revision.namespaceId,
            agentId: a.agent.id,
            revisionId: a.revision.id,
          },
          readApprovals: () =>
            readModelGrantApprovals({
              agentId: a.agent.id,
              revisionId: a.revision.id,
            }),
        },
        signal: t.signal,
      });
      assert.ok(before.grant);
      assert.equal(before.origin.priorTurnObserved, false);
      assert.equal(before.origin.count, 1);
      await sameExecution();
      assert.equal(
        (await origin.snapshot()).issued,
        0,
        "a model turn must not mint a Git credential",
      );
      assert.equal((await origin.gitRequests()).length, 0);
      await fixture.checkpoint("mixed-grant-model-before-git", {
        revisionId: a.revision.id,
        turnId: before.turnId,
        ...before.grant,
        gitIssued: 0,
      });

      phase = "first fresh Git fetch";
      // Publication happens after the first model turn. Its SHA and content come
      // from the independent origin, and neither object may preexist in the workload.
      const first = await origin.publishFreshCommit();
      await absent(first.sha);
      await fetch(first.sha, 0);
      assert.equal(
        (await run(["git", "-C", directory, "rev-parse", "FETCH_HEAD"])).trim(),
        first.sha,
      );
      assert.equal(
        await run(["git", "-C", directory, "show", `${first.sha}:${first.path}`]),
        first.content,
      );
      const fetched = await origin.snapshot();
      assert.equal(fetched.issued, 1, "the first Git fetch must cause exactly one scoped issuance");
      assert.equal(fetched.tokens.length, 1);
      const token = fetched.tokens[0];
      assert.ok(token);
      assert.deepEqual(token.repositoryIds, [gitScope.repositoryId]);
      assert.deepEqual(token.permissions, gitScope.permissions);
      const requests = await origin.gitRequests();
      assert.ok(requests.length > 0);
      let successfulRequests = 0;
      for (const request of requests) {
        if (request.status === 200) {
          assert.equal(request.tokenIndex, token.index);
          successfulRequests += 1;
        }
      }
      assert.ok(successfulRequests > 0, "the fetched object must use the newly issued credential");
      await sameExecution();
      await fixture.checkpoint("mixed-grant-git-fetched", {
        revisionId: a.revision.id,
        sha: first.sha,
        gitIssued: fetched.issued,
        gitRequests: requests.length,
      });

      phase = "Git withdrawal";
      // Include requests made during withdrawal in the denial accounting.
      const withdrawn = await origin.snapshot();
      const requestsBeforeDenial = await origin.gitRequests();
      assert.equal(withdrawn.issued, 1);
      await fixture.request("PATCH", a.path, {
        configurationId: a.configuration.id,
        repositoryBindings: [],
      });
      const second = await origin.publishFreshCommit();
      assert.notEqual(second.sha, first.sha);
      await absent(second.sha);
      const revocations = (snapshot: { endpoints: Record<string, number> }) =>
        Object.entries(snapshot.endpoints).reduce(
          (count, [endpoint, requests]) => count + (endpoint.startsWith("revoke:") ? requests : 0),
          0,
        );
      const noNewIssuerRequest = (snapshot: typeof withdrawn) => {
        assert.equal(snapshot.issued, withdrawn.issued);
        // Cleanup may revoke the earlier credential. Every other upstream request,
        // including a rejected issuance request, would violate withdrawal.
        assert.equal(
          snapshot.requests - withdrawn.requests,
          revocations(snapshot) - revocations(withdrawn),
          "withdrawn Git must be denied before a new issuer request",
        );
      };

      const identity = { sandboxId: a.target.sandboxId, revisionId: a.revision.id };
      const previousDenials = await fixture.gitWithdrawalDenials(identity, undefined);
      const executable = await run([
        "sh",
        "-ceu",
        'readlink -f "$(git --exec-path)/git-remote-https"',
      ]);
      const denial = createOpenShellGitDenial({
        gatewayClient: fixture.gatewayClient,
        workspace: fixture.workspace,
        sandbox: a.target.sandboxName,
        sandboxId: a.target.sandboxId,
        supervisor: a.supervisor,
        readSupervisor: () => fixture.verifySupervisorImage(a.target),
        executable: executable.trim(),
        signal: t.signal,
      });
      const policyBaseline = await denial.snapshot();
      phase = "withdrawn fresh Git fetch";
      const startedAt = Date.now();
      const refused = await fetch(second.sha, 128);
      const endedAt = Date.now();
      // A failed process is insufficient: require either the selected Worker's
      // explicit withdrawal decision or the supplier's ordered policy denial.
      if (refused.category === "http403") {
        const observed = await observeUntil(
          "selected Git withdrawal decision",
          t.signal,
          async () => {
            const next = await fixture.gitWithdrawalDenials(identity, undefined);
            assert.equal(next.workerUid, previousDenials.workerUid);
            const fresh = next.requestIds.filter(
              (id: string) => !previousDenials.requestIds.includes(id),
            );
            return fresh.length ? fresh : undefined;
          },
          10_000,
        );
        assert.equal(new Set(observed).size, 1, "the refusal must identify one new request");
        await fixture.checkpoint("mixed-grant-withdrawal-denied", {
          boundary: "signed-access-withdrawn",
          requestId: observed[0],
          workerUid: previousDenials.workerUid,
        });
      } else {
        const markerHost = `git-retention-${randomUUID()}.invalid`;
        await run([
          "node",
          "-e",
          "require('node:dns').lookup(process.argv[1], { family: 4 }, () => {});",
          `${markerHost}.`,
        ]);
        const proof = await denial.expectAfter(policyBaseline, {
          startedAt,
          endedAt,
          markerHost,
          markerEndedAt: Date.now(),
        });
        await fixture.checkpoint("mixed-grant-withdrawal-denied", {
          boundary: "supervisor-policy",
          ...proof,
        });
      }
      await absent(second.sha);
      noNewIssuerRequest(await origin.snapshot());
      assert.deepEqual(await origin.gitRequests(), requestsBeforeDenial);
      await sameExecution();
      await fixture.checkpoint("mixed-grant-git-withdrawn", {
        revisionId: a.revision.id,
        sha: second.sha,
        gitIssued: withdrawn.issued,
        gitRequests: requestsBeforeDenial.length,
        exitCode: 128,
      });

      phase = "same conversation after Git withdrawal";
      assert.equal(a.modelTurns.after.priorTurnId, a.modelTurns.before.id);
      // The helper sends only the new marker. The independent origin refuses it
      // unless the runtime forwards the earlier assistant answer in its history.
      const after = await assertOpenShellModelTurn({
        ...a.modelTurnOptions,
        sessionKey,
        turn: a.modelTurns.after,
        signal: t.signal,
      });
      assert.equal(after.sessionKey, before.sessionKey);
      assert.notEqual(after.turnId, before.turnId);
      assert.equal(after.origin.priorTurnObserved, true);
      assert.equal(after.origin.count, 1);
      await sameExecution();
      noNewIssuerRequest(await origin.snapshot());
      assert.deepEqual(await origin.gitRequests(), requestsBeforeDenial);
      await fixture.checkpoint("mixed-grant-conversation-continued", {
        revisionId: a.revision.id,
        turnId: after.turnId,
        priorTurnObserved: true,
        gitIssued: 1,
      });
    } catch (error) {
      // Raw upstream and workload errors may contain credentials. Recognize the
      // failure shape, then select its code from the platform vocabulary.
      const terminalFailure =
        error instanceof Error
          ? /^MIXED_GRANT_DEPLOYMENT_FAILED: ([A-Z][A-Z0-9_]{0,95}); selected revision failed (?:before|after) provider registration$/u.exec(
              error.message,
            )
          : null;
      let category = "operation";
      let httpStatus: number | null = null;
      if (terminalFailure) {
        category = "deployment";
      } else if (t.signal.aborted) {
        category = "cancelled";
      } else if (error instanceof AssertionError) {
        category = "assertion";
      } else if (error instanceof FixtureCommandTimeoutError) {
        category = "command-timeout";
      } else if (
        error instanceof Error &&
        "code" in error &&
        error.code === "OCC_HTTP_FAILURE" &&
        "status" in error &&
        typeof error.status === "number" &&
        Number.isInteger(error.status) &&
        error.status >= 100 &&
        error.status <= 599
      ) {
        category = "http";
        httpStatus = error.status;
      }
      const failure = {
        kind: openShellGitRetentionKind,
        event: "mixed-grant-failure",
        phase,
        category,
        httpStatus,
      };
      emitOpenShellGitRetention(t, failure);
      if (terminalFailure) {
        // eslint-disable-next-line preserve-caught-error -- The raw cause may contain credentials; retain only the fixed diagnostic.
        throw new Error(
          `MIXED_GRANT_DEPLOYMENT_FAILED: ${mixedGrantDeploymentCode(terminalFailure[1])}; verification phase ${phase}.`,
        );
      }
      const locations: string[] = [];
      if (error instanceof Error && typeof error.stack === "string") {
        const sources = [
          "tests/integration/openshell-mixed-grant-real.test.ts",
          "tests/helpers/openshell-git-installation.mjs",
          "tests/helpers/openshell-mixed-grant-agent.ts",
          "tests/helpers/openshell-mixed-grant-setup.ts",
          "tests/helpers/openshell-model-turn.ts",
          "tests/helpers/local-first-agent-stack.mjs",
          "tests/fixtures/repository-credentials/process.mjs",
        ];
        // Exclude the complete message, including multiline assertion details.
        // Only fixed source paths and numeric coordinates may leave this catch.
        const messageIndex = error.stack.indexOf(error.message);
        const frames =
          messageIndex < 0 ? "" : error.stack.slice(messageIndex + error.message.length);
        for (const line of frames.split("\n").slice(0, 32)) {
          const frame =
            /^\s+at (?:[^()\n]* \()?((?:file:\/\/|\/)[^()\n]+):([1-9]\d{0,5}):([1-9]\d{0,5})\)?$/u.exec(
              line,
            );
          if (!frame) {
            continue;
          }
          const source = sources.find((candidate) => {
            const url = new URL(`../../${candidate}`, import.meta.url);
            return frame[1] === url.href || frame[1] === fileURLToPath(url);
          });
          if (source) {
            locations.push(`${source}:${frame[2]}:${frame[3]}`);
            if (locations.length === 3) {
              break;
            }
          }
        }
      }
      const location = locations.length ? locations.join(" -> ") : "location unavailable";
      const status = httpStatus === null ? "" : ` HTTP ${httpStatus}`;
      // eslint-disable-next-line preserve-caught-error -- Preserve only closed diagnostics; the raw cause may contain credentials.
      throw new Error(
        `Mixed model and Git grant verification failed (${phase}; ${category}${status}; ${location}).`,
      );
    }
  },
);
