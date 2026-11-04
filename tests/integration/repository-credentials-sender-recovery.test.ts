import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { once } from "node:events";
import { realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { socketDirectory } from "../helpers/socket-directory.mjs";

// Node's test runner gives this file a fresh process, before any broker imports.
test("selected native sender recovers only the original grant without loading broker sessions", async (t) => {
  const forbidden = await realpath(
    new URL("../../apps/controller/src/drivers/repo/credentials/sessions.ts", import.meta.url),
  );
  const attempts: string[] = [];
  const hook = registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith("file:") && realpathSync(fileURLToPath(url)) === forbidden) {
        attempts.push(url);
        throw new Error("Forbidden broker sessions load");
      }
      return nextLoad(url, context);
    },
  });
  t.after(() => {
    hook.deregister();
    // Also fail if a consumer catches the load error.
    assert.deepEqual(attempts, []);
  });
  const { GitHubNativeRepositorySender } =
    await import("../../apps/controller/src/drivers/repo/github/driver.ts");
  const { UnixRepositoryCredentialControlClient } =
    await import("../../apps/controller/src/backends/repository-credentials/control-client.ts");
  const socket = join(await socketDirectory(t, "sr-", { longest: "c.sock" }), "c.sock");
  const grant = {
    providerInstanceId: "provider-original",
    repositoryId: "repository-original",
    grantId: "grant-original",
  };
  const deadlineWallMs = 1800000000000;
  const admissionId = "1799999900000-12345678-1234-4123-8123-123456789abc";
  const original = {
    sessionId: "original-session",
    state: "DISPOSED",
    deadlineWallMs,
    binding: { ...grant },
    activeUses: 0,
    cleanup: {
      active: 0,
      pending: 0,
      revoked: 1,
      expired: 0,
      uncertain: 0,
      auxiliaryPending: false,
    },
  };
  let reply = original;
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      admissionId: request.headers["x-admission-id"],
      body: JSON.parse((await buffer(request)).toString()),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply));
  });
  t.after(() => server[Symbol.asyncDispose]());
  server.listen(socket);
  await once(server, "listening");
  const sender = new GitHubNativeRepositorySender(
    {
      id: "backend-original",
      drivers: { repo: "policy-original" },
      client: new UnixRepositoryCredentialControlClient({ controlSocket: socket }),
    },
    {},
  );
  const input = {
    namespaceId: "namespace-original",
    admissionId,
    binding: {
      backendId: "backend-original",
      repositoryRef: "repo-original",
      profile: "git-write",
      grant,
    },
    durationSeconds: 100,
    deadlineWallMs,
    recoverOnly: true as const,
  };
  const expectedRequest = {
    method: "POST",
    path: "/v1/sessions",
    admissionId,
    body: {
      namespaceId: input.namespaceId,
      repositoryRef: input.binding.repositoryRef,
      expectedBinding: grant,
      profile: "git-write",
      durationSeconds: 100,
      deadlineWallMs,
      durableAdmission: true,
      recoverOnly: true,
    },
  };
  const recovered = await sender.open(input, AbortSignal.timeout(5000));
  assert.deepEqual(recovered, {
    kind: "recovered",
    status: { sessionId: original.sessionId, state: "DISPOSED", deadlineWallMs, binding: grant },
  });
  assert.ok(Object.isFrozen(recovered.status));
  assert.ok(Object.isFrozen(recovered.status.binding));
  assert.notEqual(recovered.status.binding, grant);
  // Keep the wire status valid: each refusal must come from grant equality.
  for (const field of ["providerInstanceId", "repositoryId", "grantId"] as const) {
    reply = { ...original, binding: { ...grant, [field]: `${grant[field]}-other` } };
    await assert.rejects(
      sender.open(input, AbortSignal.timeout(5000)),
      { message: "Repository credential control returned an inconsistent session." },
      field,
    );
  }
  assert.deepEqual(requests, Array(4).fill(expectedRequest));
});
