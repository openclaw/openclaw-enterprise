import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import type { SessionStatus } from "../../apps/controller/src/drivers/repo/credentials/service-contracts.ts";
import { run, temporaryDirectory } from "../fixtures/repository-credentials/process.mjs";
import { socketDirectory } from "../helpers/socket-directory.mjs";

for (const outcome of ["lost reply", "recovered status"] as const) {
  test(`operator preserves original admission after ${outcome}`, async (t) => {
    const socket = join(await socketDirectory(t, "operator-"), "control.sock");
    const directory = await temporaryDirectory(t, "operator-output-");
    const admissionId = `${Date.now()}-${randomUUID()}`;
    const binding = {
      providerInstanceId: "provider-test",
      repositoryId: "repository-test",
      grantId: "grant-test",
    };
    const status: SessionStatus = {
      sessionId: "original-session",
      state: "CLOSED",
      deadlineWallMs: Date.now() + 60_000,
      binding,
      activeUses: 0,
      cleanup: {
        active: 0,
        pending: 1,
        revoked: 0,
        expired: 0,
        uncertain: 1,
        auxiliaryPending: false,
      },
    };
    const profile = "sensitive-request-marker";
    const request = { durationSeconds: 60, profile };
    const recovered = outcome === "recovered status";
    const body = recovered
      ? {
          ...request,
          namespaceId: "namespace-test",
          repositoryRef: "project",
          expectedBinding: binding,
          deadlineWallMs: status.deadlineWallMs,
          recoverOnly: true,
        }
      : request;
    const requestPath = join(directory, "request.json");
    if (recovered) {
      await writeFile(requestPath, JSON.stringify(body), { mode: 0o600 });
    }
    const before = await readdir(directory);
    const requests: unknown[] = [];
    // This peer supplies transport outcomes, not provider or admission-owner proof.
    const server = createServer(async (incoming, response) => {
      let received = "";
      for await (const chunk of incoming) {
        received += chunk;
      }
      requests.push({
        method: incoming.method,
        path: incoming.url,
        admissionId: incoming.headers["x-admission-id"],
        body: JSON.parse(received),
      });
      if (recovered) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(status));
      } else {
        incoming.socket.destroy();
      }
    });
    t.after(() => new Promise<void>((done) => server.close(() => done())));
    server.listen(socket);
    await once(server, "listening");
    const { code, stdout, stderr } = await run(
      process.execPath,
      [
        resolve("apps/controller/src/drivers/repo/github/credentials/client/operator.ts"),
        "open",
        "--socket",
        socket,
        "--output",
        join(directory, "session"),
        "--admission-id",
        admissionId,
        ...(recovered
          ? ["--request-json", requestPath]
          : ["--duration-seconds", "60", "--profile", profile]),
      ],
      { timeout: 10_000, allowFailure: true },
    );
    assert.deepEqual(requests, [
      {
        method: "POST",
        path: "/v1/sessions",
        admissionId,
        body: recovered ? { ...body, durableAdmission: true } : body,
      },
    ]);
    assert.deepEqual(await readdir(directory), before, "no client material or staging directory");
    assert.ok(stderr.includes(admissionId), "retain the original admission identity");
    assert.match(stderr, /original owner/);
    assert.match(stderr, /status/);
    assert.doesNotMatch(stderr, /\b(?:open|replace|new admission)\b/i);
    assert.ok(!(stdout + stderr).includes(profile), "do not disclose request data");
    if (recovered) {
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(stdout), { ...status, recovered: true });
      assert.ok(stderr.includes(status.sessionId), "identify the original session");
    } else {
      assert.equal(code, 1);
      assert.equal(stdout, "", "a lost reply establishes neither absence nor success");
      assert.match(stderr, /uncertain/);
      assert.match(stderr, /credential-operator-failed/);
    }
  });
}
