import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import test from "node:test";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import { run } from "../fixtures/repository-credentials/process.mjs";
import { controlRequest } from "../fixtures/repository-credentials/service.mjs";
import { socketDirectory } from "../helpers/socket-directory.mjs";
import {
  controlledClock,
  isJsonObject,
  readJsonObject,
  startRegistryFixture,
} from "./repository-credentials-driver-fixture.ts";

const requestControl: (
  socketPath: string,
  method: string,
  path: string,
  value: unknown,
  headers: Record<string, string>,
) => Promise<{ status: number | undefined; body: unknown }> = controlRequest;

export function registerAdmissionCapabilityCases() {
  test("durable admission capability rejects an old response, malformed replies, and timeouts", async (t) => {
    let response: { status: number; body: unknown; contentType?: string } | undefined = {
      status: 404,
      body: { error: "not-found" },
    };
    const server = createServer((incoming, outgoing) => {
      if (incoming.url === "/healthz") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ ready: true, protocolVersion: 1 }));
        return;
      }
      if (response === undefined) {
        return;
      }
      outgoing.writeHead(response.status, {
        "content-type": response.contentType ?? "application/json",
      });
      outgoing.end(JSON.stringify(response.body));
    });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    // Registered after the close hook, so the server closes before its directory goes.
    const socket = join(await socketDirectory(t, "repository-capability-"), "control.sock");
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const client = new UnixRepositoryCredentialControlClient({ controlSocket: socket });
    // An older broker reports healthy protocol 1 but does not recognize this endpoint.
    await client.health(AbortSignal.timeout(1000));
    // Every refusal is the retryable control error, never a parse or type error.
    const unavailable = { name: "RepositoryCredentialControlError", retryable: true };
    await assert.rejects(client.checkAdmissionReady(AbortSignal.timeout(1000)), unavailable);
    for (const value of [
      { status: 200, body: {} },
      { status: 200, body: { durableAdmissionVersion: 2 } },
      { status: 200, body: { durableAdmissionVersion: "1" } },
      { status: 503, body: { error: "unavailable" } },
      // A well-formed reply still needs both a 200 status and a JSON content type.
      { status: 503, body: { durableAdmissionVersion: 1 } },
      { status: 200, body: { durableAdmissionVersion: 1 }, contentType: "text/plain" },
    ]) {
      response = value;
      await assert.rejects(client.checkAdmissionReady(AbortSignal.timeout(1000)), unavailable);
    }
    response = { status: 200, body: { durableAdmissionVersion: 1 } };
    await client.checkAdmissionReady(AbortSignal.timeout(1000));
    response = undefined;
    await assert.rejects(client.checkAdmissionReady(AbortSignal.timeout(50)), unavailable);
  });

  test(
    "controller image probe correlates real Driver calls with an isolated receipt fixture",
    { timeout: 30000 },
    async (t) => {
      const fixture = await startRegistryFixture(t, {
        autoOpen: false,
        clock: { ...controlledClock(), wallNow: Date.now },
        gateway: { listen: "127.0.0.1:0" },
      });
      assert.ok(fixture);
      const receipts: unknown[] = [];
      let hideReceiptObservation = false;
      const receiptServer = createServer(async (incoming, outgoing) => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming as AsyncIterable<unknown>) {
          assert.ok(Buffer.isBuffer(chunk));
          chunks.push(chunk);
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!hideReceiptObservation) {
          receipts.push(body);
        }
        // The fixture supplies only a missing recovery result or a failed reserve.
        // It never acknowledges a reservation or creates provider authority.
        // Null has no readable kind. Other non-recovery packets receive the 503 reply.
        assert.notEqual(body, null);
        if (isJsonObject(body) && body.kind === "recover") {
          outgoing.writeHead(200, { "content-type": "application/json" });
          outgoing.end(JSON.stringify({ kind: "missing" }));
        } else {
          outgoing.writeHead(503, { "content-type": "application/json" });
          outgoing.end(JSON.stringify({ error: "fixture-unavailable" }));
        }
      });
      const receiptSocket = join(dirname(fixture.config.gateway.controlSocket), "receipt.sock");
      await new Promise<void>((resolve, reject: (reason?: unknown) => void) => {
        receiptServer.once("error", reject);
        receiptServer.listen(receiptSocket, resolve);
      });
      t.after(async () => {
        receiptServer.closeAllConnections();
        await new Promise<void>((resolve) => receiptServer.close(() => resolve()));
      });
      const probe = new URL(
        "../../apps/controller/src/drivers/repo/github/access/admission-probe.ts",
        import.meta.url,
      ).pathname;
      for (const [mode, outcome] of [
        ["recover", "missing"],
        ["reserve", "unavailable"],
      ] as const) {
        const admissionId = `${Date.now()}-${randomUUID()}`;
        const result = await run(process.execPath, [
          probe,
          fixture.config.gateway.controlSocket,
          mode,
          admissionId,
        ]);
        const report = readJsonObject(result.stdout);
        assert.deepEqual(
          {
            version: report.version,
            mode: report.mode,
            admissionId: report.admissionId,
            outcome: report.outcome,
          },
          { version: 1, mode, admissionId, outcome },
        );
        const observed = receipts.at(-1);
        assert.ok(isJsonObject(observed));
        assert.equal(observed.kind, mode);
        assert.equal(observed.admissionId, admissionId);
        assert.deepEqual(observed.input, report.input);
      }
      // An old Driver omits durableAdmission; the new broker rejects it before
      // contacting the receipt fixture, so a generic failure cannot qualify the pair.
      const firstReceipt = receipts[0];
      assert.ok(isJsonObject(firstReceipt));
      const first = firstReceipt.input;
      assert.ok(first && typeof first === "object");
      const input = { ...first, recoverOnly: true };
      const before = receipts.length;
      const { status } = await requestControl(
        fixture.config.gateway.controlSocket,
        "POST",
        "/v1/sessions",
        input,
        { "x-admission-id": `${Date.now()}-${randomUUID()}` },
      );
      assert.equal(status, 400);
      assert.equal(receipts.length, before);
      // An unavailable result alone cannot prove which request reached the
      // broker. Qualification must also match the fixture's reserve observation.
      hideReceiptObservation = true;
      const unobservedId = `${Date.now()}-${randomUUID()}`;
      const unobserved = await run(process.execPath, [
        probe,
        fixture.config.gateway.controlSocket,
        "reserve",
        unobservedId,
      ]);
      assert.equal(readJsonObject(unobserved.stdout).outcome, "unavailable");
      assert.equal(
        receipts.some((receipt) => isJsonObject(receipt) && receipt.admissionId === unobservedId),
        false,
      );
      assert.ok(fixture.repositories.every(({ github }) => github.issuesOfTokens.length === 0));
    },
  );
}
