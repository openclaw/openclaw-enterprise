import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { TestContext } from "node:test";

import type { RepositoryCredentialSessionResult } from "../../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import { appFunction } from "./app-functions.ts";
import { closeAndDispose, registerResourceCleanup, type ResourceCleanup } from "./cleanup.ts";
import { runPinnedClients } from "./clients.ts";
import { writeSessionClientConfiguration } from "./service-resources.ts";
import { removeRemoteBranches } from "./workflows.ts";

type PinnedClients = Awaited<ReturnType<typeof runPinnedClients>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function admittedSessionId(reply: unknown): string {
  assert.ok(
    isRecord(reply) && !("error" in reply) && isRecord(reply.session),
    "live session admission failed",
  );
  const { sessionId } = reply.session;
  assert.ok(
    typeof sessionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId),
    "invalid live session ID",
  );
  return sessionId;
}

function assertOpenSession(
  reply: unknown,
  sessionId: string,
): asserts reply is RepositoryCredentialSessionResult {
  assert.ok(isRecord(reply), "live session admission failed");
  const { session, bearer, client } = reply;
  assert.ok(
    isRecord(session) &&
      session.sessionId === sessionId &&
      session.state === "OPEN" &&
      typeof session.deadlineWallMs === "number" &&
      Number.isFinite(session.deadlineWallMs) &&
      typeof session.activeUses === "number" &&
      isRecord(session.binding) &&
      typeof session.binding.providerInstanceId === "string" &&
      typeof session.binding.repositoryId === "string" &&
      typeof session.binding.grantId === "string" &&
      isRecord(session.cleanup) &&
      typeof session.cleanup.active === "number" &&
      typeof session.cleanup.pending === "number" &&
      typeof session.cleanup.revoked === "number" &&
      typeof session.cleanup.expired === "number" &&
      typeof session.cleanup.uncertain === "number" &&
      typeof session.cleanup.auxiliaryPending === "boolean" &&
      typeof bearer === "string" &&
      isRecord(client) &&
      typeof client.gatewayOrigin === "string" &&
      typeof client.gitRemote === "string" &&
      typeof client.gitUsername === "string" &&
      typeof client.canonicalApiHost === "string" &&
      typeof client.apiHost === "string" &&
      typeof client.repository === "string",
    "invalid live session material",
  );
  const allowlist: unknown = client.pushRefAllowlist;
  assert.ok(
    Array.isArray(allowlist) &&
      allowlist.length === 1 &&
      allowlist[0] === "refs/heads/credential-smoke/*",
    "live session must grant only credential-smoke branches",
  );
}

function parseResourceId(stdout: string, key: "number" | "id"): number {
  const value: unknown = JSON.parse(stdout);
  assert.ok(isRecord(value), "expected a GitHub resource object");
  const id = value[key];
  assert.ok(
    typeof id === "number" && Number.isSafeInteger(id) && id > 0,
    `invalid GitHub resource ${key}`,
  );
  return id;
}

export async function exerciseLiveWorkflow(
  t: TestContext,
  { socket, readPublicCa }: { socket: string; readPublicCa(): Promise<Uint8Array> },
): Promise<void> {
  const callControl = await appFunction(
    "drivers/repo/github/access/client/operator",
    "callControl",
  );
  // Treat the operator's declared response as untrusted across the Unix socket.
  const reply: unknown = await callControl(socket, {
    method: "POST",
    path: "/v1/sessions",
    body: { durationSeconds: 300, profile: "git-full" },
  });
  const id = admittedSessionId(reply);
  const workSignal = AbortSignal.any([t.signal, AbortSignal.timeout(90000)]);
  const cleanups: ResourceCleanup[] = [];
  let clientDirectory: string | undefined;
  let cleanupClient: PinnedClients | undefined;
  let workFailure: { error: unknown } | undefined;

  const requireCleanupClient = () => {
    assert.ok(cleanupClient, "cleanup client unavailable");
    return cleanupClient;
  };
  const request: Parameters<typeof registerResourceCleanup>[1]["request"] = async (
    { method, path, body },
    signal,
  ) => {
    const client = requireCleanupClient();
    const args = ["api", "--method", method, path];
    if (body !== undefined) {
      args.push("--input", await client.json("cleanup.json", body));
    }
    const response = await client.gh(args, {
      ...(signal === undefined ? {} : { signal }),
      timeout: 5000,
    });
    const data: unknown = response.stdout ? JSON.parse(response.stdout) : undefined;
    return data;
  };

  try {
    assertOpenSession(reply, id);
    clientDirectory = await writeSessionClientConfiguration(t, {
      opened: reply,
      ca: await readPublicCa(),
    });
    const client = await runPinnedClients(t, { clientDirectory }, { signal: workSignal });
    const checkout = join(client.directory, "checkout");
    const branch = `credential-smoke/${randomBytes(16).toString("hex")}`;
    const repository = reply.client.repository;
    const prefix = `repos/${repository}`;
    const marker = (kind: "pull" | "issue" | "comment") => `<!-- ${branch}:${kind} -->`;
    const write = (method: "POST" | "PATCH", path: string, input: string) =>
      client.gh(["api", "--method", method, path, "--input", input]);

    await client.git(["clone", reply.client.gitRemote, checkout]);
    await client.git(["fetch", "origin"], { cwd: checkout });
    const base = (await client.git(["branch", "--show-current"], { cwd: checkout })).stdout.trim();
    await client.git(["switch", "-c", branch], { cwd: checkout });
    await client.git(["config", "user.name", "Credential smoke"], { cwd: checkout });
    await client.git(["config", "user.email", "credential-smoke@example.test"], { cwd: checkout });
    await client.git(["commit", "--allow-empty", "-m", "Credential gateway smoke"], {
      cwd: checkout,
    });

    // The provider may accept the push before Git reports failure. Reconcile the
    // owned ref even when the client cannot determine the result.
    cleanups.push(() => removeRemoteBranches(requireCleanupClient(), checkout, [branch]));
    await client.git(["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: checkout });

    const pullMarker = marker("pull");
    const pullInput = await client.json("pull.json", {
      title: "Credential gateway smoke",
      body: pullMarker,
      base,
      head: branch,
    });
    registerResourceCleanup(cleanups, {
      request,
      repository,
      kind: "pulls",
      marker: pullMarker,
      head: branch,
    });
    const pull = await write("POST", `${prefix}/pulls`, pullInput);
    const pullNumber = parseResourceId(pull.stdout, "number");
    await client.gh(["api", `${prefix}/pulls/${pullNumber}`]);
    const updateInput = await client.json("update.json", {
      title: "Credential gateway smoke checked",
    });
    await write("PATCH", `${prefix}/pulls/${pullNumber}`, updateInput);

    const issueMarker = marker("issue");
    const issueInput = await client.json("issue.json", {
      title: "Credential gateway smoke",
      body: issueMarker,
    });
    registerResourceCleanup(cleanups, { request, repository, kind: "issues", marker: issueMarker });
    const issue = await write("POST", `${prefix}/issues`, issueInput);
    const issueNumber = parseResourceId(issue.stdout, "number");
    const commentsPath = `${prefix}/issues/${issueNumber}/comments`;
    const commentMarker = marker("comment");
    const commentInput = await client.json("comment.json", { body: commentMarker });
    registerResourceCleanup(cleanups, {
      request,
      repository,
      kind: "comment",
      marker: commentMarker,
      issueNumber,
    });
    const comment = await write("POST", commentsPath, commentInput);
    parseResourceId(comment.stdout, "id");
    await client.gh(["api", "--paginate", commentsPath]);
  } catch (error) {
    workFailure = { error };
  }

  const failures: string[] = [];
  // Cancellation of the work client must not cancel remote reconciliation.
  const cleanupSignal = AbortSignal.timeout(60000);
  if (clientDirectory && cleanups.length > 0) {
    try {
      cleanupClient = await runPinnedClients(t, { clientDirectory }, { signal: cleanupSignal });
    } catch {
      failures.push("cleanup client unavailable");
    }
  }
  for (const action of cleanups.reverse()) {
    try {
      await action(cleanupSignal);
    } catch (error) {
      failures.push(
        error instanceof Error && /^unresolved (issues|pulls|comment)/.test(error.message)
          ? error.message
          : "live resource reconciliation failed",
      );
    }
  }

  // Always attempt local closure and verify disposal, even after the remote
  // cleanup budget expires or the cleanup client fails to start.
  try {
    await closeAndDispose(callControl, socket, id);
  } catch (error) {
    failures.push(
      error instanceof Error && /^session cleanup/.test(error.message)
        ? error.message
        : "session cleanup failed",
    );
  }
  if (failures.length > 0) {
    throw new Error(`live cleanup requires operator attention: ${failures.join("; ")}`, {
      cause: workFailure?.error,
    });
  }
  if (workFailure) {
    throw workFailure.error;
  }
}
