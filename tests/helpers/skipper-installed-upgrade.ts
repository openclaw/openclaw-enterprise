// The selected test owns a fresh k3d installation, model peer and private Git witness.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { prepareComputeSkipper } from "./skipper-prepared-compute.mjs";

type Installed = Awaited<ReturnType<typeof prepareComputeSkipper>>;
interface Fixture {
  id: string;
  initialSha: string;
  repository: string;
  repositoryRef: string;
  approvalRef: string;
}
interface ProviderToken {
  index: number;
  revoked: boolean;
  uses: number;
  repositoryIds: string[];
  permissions: Record<string, string>;
}
interface Evidence {
  endpoints: Record<string, number>;
  tokens: ProviderToken[];
}
interface Session {
  admission_id: string;
  session_id: string;
  predecessor_admission_id: string | null;
}
interface UpgradeInput {
  sourceCommit: string;
  directory: string;
  kubeconfig: string;
  context: string;
  system: string;
  upgrade: { candidateImages: { controller: string; repository: string }; candidateCli: string };
}

const execute = promisify(execFile);

// An interrupted helper can leave children or remote writes in flight.
export async function upgradeNeedsRecovery(directory: string) {
  const exists = (file: string) =>
    stat(join(directory, file)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return false;
        }
        throw error;
      },
    );
  // The helper records its first temporary NetworkPolicy or Secret create before dispatch.
  // A surviving lock can also mean a live subprocess. A completed legacy refusal clears the lock.
  const preflight = "upgrade-preflight/";
  if (
    (await exists(preflight + ".upgrade-lock")) ||
    (((await exists(preflight + "preflight-networkpolicy-started.json")) ||
      (await exists(preflight + "preflight-secret-started.json"))) &&
      !(await exists(preflight + "startup-preflight-passed")))
  ) {
    return true;
  }
  return (await exists("apply-intent")) && !(await exists("upgrade-apply/completed"));
}

async function upgradeInstallation(input: UpgradeInput, installed: Installed) {
  const writers = await installed.writerState(undefined);
  const local = join(input.directory, "local-setup");
  assert.equal(input.kubeconfig, join(local, "kubeconfig"));
  assert.match(input.context, /^k3d-occ-dev-skipper-[a-f0-9]{12}$/);
  assert.equal(input.system, "oce-system");
  const { candidateImages, candidateCli } = input.upgrade;
  assert.equal(candidateCli, join(input.directory, "candidate-occ"));
  const state = JSON.parse(await readFile(join(local, "state.json"), "utf8"));
  assert.equal(input.context, "k3d-" + state.cluster);
  assert.equal(state.browserPort, 8443);
  const origin = "https://console." + state.cluster + ".oce.localhost:8443";
  // The k3d installer writes the public origin in the release values.
  const helm = JSON.parse(await readFile(join(local, "helm-values.json"), "utf8"));
  assert.equal(helm.auth.baseUrl, origin);
  const key = join(local, "initial-admin-service-key.json");
  assert.equal(state.keyPath, key);
  for (const phase of ["preflight", "apply"] as const) {
    await installed.checkpoint("upgrade-" + phase + "-started");
    const evidence = join(input.directory, "upgrade-" + phase);
    if (phase === "apply") {
      await writeFile(join(input.directory, "apply-intent"), input.sourceCommit, {
        mode: 0o600,
        flag: "wx",
        flush: true,
      });
    }
    // Native diagnostics stay private. Reconciliation belongs to the operator after an uncertain write.
    const log = await open(evidence + ".log", "wx", 0o600);
    try {
      const args = [
        "--kubeconfig",
        input.kubeconfig,
        "--context",
        input.context,
        "--namespace",
        input.system,
        "--release",
        "openclaw-enterprise",
        "--values",
        join(local, "helm-values.json"),
        "--installation",
        join(local, "installation.yaml"),
        "--occ",
        candidateCli,
        "--source-revision",
        input.sourceCommit,
        "--controller-image",
        candidateImages.controller,
        "--broker-image",
        candidateImages.repository,
        "--evidence-dir",
        evidence,
        ...(phase === "preflight" ? ["--preflight-only"] : []),
      ];
      const result = await execute("scripts/upgrade-production-images", args, {
        env: {
          ...process.env,
          OCC_URL: origin,
          OCC_CA_BUNDLE: join(local, "browser-ca.crt"),
          OCC_SERVICE_KEY_FILE: key,
        },
        timeout: 35 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
      }).catch(
        async (error: { code?: number; signal?: string; stderr?: string; stdout?: string }) => {
          await log.writeFile((error.stdout ?? "") + (error.stderr ?? ""));
          if (
            phase === "preflight" &&
            error.code === 1 &&
            error.stderr?.includes("A direct upgrade is unsupported.")
          ) {
            assert.deepEqual(await installed.writerState(undefined), writers);
            await installed.stable();
            await installed.ordinaryChat("upgrade-refusal-original-agent", "before-private-git");
            await installed.checkpoint("upgrade-refused-original-writers-and-agent-serving");
          }
          throw new Error(
            "Installed " +
              phase +
              " failed (" +
              (error.signal ?? error.code ?? "unknown") +
              "), see private " +
              evidence +
              ".log",
          );
        },
      );
      await log.writeFile(result.stdout + result.stderr);
      if (phase === "apply") {
        assert.equal(await readFile(join(evidence, "completed"), "utf8"), "");
      }
    } finally {
      await log.close();
    }
  }
}

export async function verifyInstalledUpgrade(
  input: UpgradeInput,
  installed: Installed,
  git: Fixture,
  witness: {
    (path: "/evidence"): Promise<Evidence>;
    (path: "/refs"): Promise<Record<string, string>>;
  },
) {
  const { waitFor } = installed;
  assert.match(git.id, /^[a-f0-9]{16}$/);
  assert.equal(git.repository, "fixture/skipper-" + git.id);
  assert.equal(git.repositoryRef, "private-git");
  assert.equal(git.approvalRef, "refs/heads/review/skipper-" + git.id);
  assert.match(git.initialSha, /^[0-9a-f]{40}$/);
  const { agent, agentPath, approval, api, query, namespaceId, sendScript, checkpoint } = installed;
  assert.equal(approval.status, "active");
  const admittedApproval = async (revisionId: string) => {
    const result = await query(
      `SELECT admitted_spec #>> '{repository_credentials,standingApprovalId}' AS id,
              admitted_spec #>> '{repository_credentials,standingApprovalGeneration}' AS generation,
              admitted_spec #>> '{repository_credentials,standingApprovalScopeFingerprint}' AS fingerprint
         FROM occ.agent_revisions WHERE namespace_id=$1 AND agent_id=$2 AND id=$3`,
      [namespaceId, agent.id, revisionId],
    );
    assert.deepEqual(result.rows, [
      {
        id: approval.id,
        generation: String(approval.generation),
        fingerprint: approval.scopeFingerprint,
      },
    ]);
  };
  await admittedApproval(installed.revision.id);
  const stopped = await installed.stoppedControl();
  await installed.ordinaryChat("upgrade-baseline-chat", "before-private-git");
  const url = "https://github.com/" + git.repository + ".git";
  const root = "/home/node/workspace";
  const repo = root + "/upgrade-" + git.id;
  const marker = randomUUID();
  const pre = [
    "set -eu; set +x",
    'test "$(git ls-remote --get-url ' +
      url +
      ')" = https://git.oce-system.svc.cluster.local/' +
      git.repository +
      ".git",
  ];
  // Create a unique commit and confirm the origin received it. Leave the retained marker outside Git.
  const before = await sendScript(
    [
      ...pre,
      "printf '%s' " + marker + " > " + root + "/cutover-" + git.id,
      "git clone -- " + url + " " + repo,
      "cd " + repo,
      'test "$(git rev-parse HEAD)" = ' + git.initialSha,
      "git -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -qm Cutover",
      "git push origin HEAD:" + git.approvalRef,
      "git rev-parse HEAD",
    ].join("\n"),
    "upgrade-before",
  );
  const refs = await witness("/refs");
  const expected = refs[git.approvalRef];
  assert.match(expected ?? "", /^[a-f0-9]{40}$/);
  assert.notEqual(expected, git.initialSha);
  assert.ok(before.commitShas.includes(expected));
  const session = async (revision: string): Promise<Session | undefined> => {
    const result = await query(
      "SELECT admission_id, session_id, predecessor_admission_id FROM occ.repository_session_attempts WHERE namespace_id=$1 AND agent_id=$2 AND revision_id=$3 AND repository_ref=$4 AND phase='open'",
      [namespaceId, agent.id, revision, git.repositoryRef],
    );
    assert.ok(result.rows.length <= 1);
    const row: unknown = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    assert.ok(
      row &&
        typeof row === "object" &&
        "admission_id" in row &&
        typeof row.admission_id === "string",
    );
    assert.ok("session_id" in row && typeof row.session_id === "string");
    assert.ok(
      "predecessor_admission_id" in row &&
        (row.predecessor_admission_id === null || typeof row.predecessor_admission_id === "string"),
    );
    return {
      admission_id: row.admission_id,
      session_id: row.session_id,
      predecessor_admission_id: row.predecessor_admission_id,
    };
  };
  const original = await session(installed.revision.id);
  assert.ok(original);
  const oldTokens = (await witness("/evidence")).tokens;
  assert.ok(oldTokens.some((token) => !token.revoked && token.uses > 0));
  await checkpoint("upgrade-baseline-ready", {
    agentId: agent.id,
    session: original.session_id,
    sha: expected,
  });
  await upgradeInstallation(input, installed);
  await installed.writerState(input.upgrade.candidateImages);
  const current = await installed.reconnect();
  assert.deepEqual(current.repositoryBindings, [
    { repositoryRef: git.repositoryRef, profile: "git-write" },
  ]);
  assert.deepEqual(await api("GET", agentPath + "/repository-approvals"), [approval]);
  await admittedApproval(current.activeRevisionId);
  const [scope] = await api("GET", agentPath + "/repository-approval-scopes");
  assert.equal(scope.scopeFingerprint, approval.scopeFingerprint);
  const history = await installed.observeTurn(before.marker);
  assert.equal(history.threadId, before.threadId);
  assert.equal(history.turnId, before.turnId);
  assert.ok(history.commitShas.includes(expected));
  // Wait for a real subsequent standing session on the restored execution. No clock or database writes.
  const restored = await waitFor("restored open Git session", () =>
    session(current.activeRevisionId),
  );
  assert.notEqual(restored.session_id, original.session_id, "original sender session was replaced");
  const renewed: Session = await waitFor(
    "standing session renewed after upgrade",
    async () => {
      const live = await session(current.activeRevisionId);
      if (live && live.predecessor_admission_id === restored.admission_id) {
        return live;
      }
    },
    13 * 60_000,
  );
  assert.notEqual(renewed.session_id, original.session_id);
  assert.notEqual(renewed.session_id, restored.session_id);
  // Session admission and provider preparation are separate worker operations.
  const { token, evidence: beforeFetch } = await waitFor(
    "renewed credential ready and old credentials retired",
    async () => {
      const evidence = await witness("/evidence");
      const active = evidence.tokens.filter((token) => !token.revoked);
      if (
        active.length === 1 &&
        oldTokens.every(
          (old) => evidence.tokens.find((t) => t.index === old.index)?.revoked === true,
        )
      ) {
        return { evidence, token: active[0]! };
      }
    },
  );
  const permits = async (operation: string) =>
    (
      await query(
        "SELECT exchange_id FROM occ.prepared_repository_git_uses WHERE admission_id=$1 AND operation=$2",
        [renewed.admission_id, operation],
      )
    ).rows.length;
  const readsBefore = await permits("upload-pack");
  assert.deepEqual(token.repositoryIds, ["73"]);
  assert.deepEqual(token.permissions, { metadata: "read", contents: "write" });
  const cold = repo + "-cold";
  const after = await sendScript(
    [
      ...pre,
      'test "$(cat ' + root + "/cutover-" + git.id + ')" = ' + marker,
      "test ! -e " + cold,
      "git init -q " + cold,
      "cd " + cold,
      "if git cat-file -e " + expected + "^{commit} 2>/dev/null; then exit 71; fi",
      "git fetch --no-tags " + url + " " + git.approvalRef,
      'test "$(git rev-parse FETCH_HEAD)" = ' + expected,
      "git rev-parse FETCH_HEAD",
    ].join("\n"),
    "upgrade-after",
  );
  assert.equal(after.threadId, before.threadId);
  assert.notEqual(after.turnId, before.turnId);
  assert.ok(after.commitShas.includes(expected));
  const fetched = await witness("/evidence");
  assert.ok(
    (fetched.endpoints["upload-pack:200"] ?? 0) > (beforeFetch.endpoints["upload-pack:200"] ?? 0),
  );
  assert.ok(
    fetched.tokens.some((t) => t.index === token.index && t.uses > token.uses && !t.revoked),
  );
  assert.ok(
    (await permits("upload-pack")) > readsBefore,
    "renewed admission authorized this fetch",
  );
  const allowed = await permits("receive-pack");
  await sendScript(
    [
      ...pre,
      "cd " + cold,
      "if git push " + url + " FETCH_HEAD:refs/heads/forbidden >denied.out 2>&1; then exit 72; fi",
      "grep -Fq repository-push-ref-not-allowed denied.out",
    ].join("\n"),
    "upgrade-denied-ref",
  );
  assert.deepEqual(await witness("/refs"), refs);
  assert.equal(
    (await witness("/evidence")).endpoints["receive-pack:200"],
    fetched.endpoints["receive-pack:200"],
  );
  assert.equal(
    await permits("receive-pack"),
    allowed,
    "forbidden ref released no write credential",
  );
  // The broker refuses discovery for an unregistered path. Keep the Git trace inside the
  // Agent and require the actual HTTP refusal, so a DNS, TLS or local failure cannot pass.
  const wrongRepo =
    "https://git.oce-system.svc.cluster.local/fixture/unapproved-" + git.id + ".git";
  const beforeDenial = await witness("/evidence");
  const readPermits = async () =>
    (await permits("advertise-upload-pack")) + (await permits("upload-pack"));
  const reads = await readPermits();
  await sendScript(
    [
      ...pre,
      "cd " + cold,
      "(set +e; LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_TRACE_REDACT=1 GIT_TRACE_CURL=1 GIT_TRACE_CURL_NO_DATA=1 git fetch --no-tags " +
        wrongRepo +
        " HEAD; printf '\\nfetch-exit=%d\\n' \"$?\") 2>&1 | awk '",
      "/=> Send header: GET .*unapproved-" +
        git.id +
        "[.]git\\/info\\/refs[?]service=git-upload-pack / { requested=1 }",
      "/<= Recv header: HTTP\\/[0-9.]+ 401( |$)/ { if (requested) denied=1 }",
      "/^fetch-exit=128$/ { failed=1 }",
      "END { exit !(requested && denied && failed) }'",
    ].join("\n"),
    "upgrade-denied-repository-read",
  );
  assert.deepEqual(await witness("/evidence"), beforeDenial);
  assert.equal(await readPermits(), reads);
  await stopped();
  await checkpoint("upgrade-continuity-verified", {
    agentId: agent.id,
    session: renewed.session_id,
    sha: expected,
  });
}
