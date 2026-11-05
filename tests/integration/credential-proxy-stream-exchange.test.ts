import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawController } from "../../packages/occ/src/index.ts";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

type WireTime = { seconds: string | number; nanos?: number };
const millis = (time: WireTime) => Number(time.seconds) * 1000 + (time.nanos ?? 0) / 1_000_000;

for (const priorLease of [false, true]) {
  for (const finish of ["recover", "withdraw"] as const) {
    test(`OpenShell exchange: ${priorLease ? "post-renewal" : "first-renewal"} outage, then ${finish}`, async (t) => {
      let clock: number | undefined;
      const f = await staticEgressFixture(t, { now: () => new Date(clock ?? Date.now()) });
      assert.ok("beginExchange" in f);
      const captured = f.capture();
      const peer = await f.beginExchange(f.metadata({ exp: Math.floor(Date.now() / 1000) + 3600 }));
      peer.stream.write(peer.opening(captured));
      const { ready, refused } = (await peer.next()).resolved;
      assert.ok(ready, `resolve refused with wire code ${refused?.code}`);
      const permit = f.permitRequest(captured, ready);
      peer.stream.write({ authorize: permit });
      const { allowed } = (await peer.next()).authorized;
      assert.deepEqual(allowed.response_custody, captured.response_custody);
      assert.deepEqual(allowed.credential_headers_sha256, permit.credential_headers_sha256);

      // These bytes arrive from the HTTPS provider before OCE decides whether to return them.
      const upstream = (await f.send(captured, ready)) as {
        status: number;
        body: Buffer;
        response_complete: boolean;
      };
      const expected = Buffer.from(JSON.stringify({ output: "fixture answer" }));
      assert.equal(f.providerRequests.length, 1);
      assert.equal(upstream.status, 200);
      assert.equal(upstream.response_complete, true);
      assert.deepEqual(upstream.body, expected);

      async function progress(bodyBytes: number) {
        peer.stream.write({ progress: { head_received: true, body_bytes: bodyBytes } });
        const { lease } = await peer.next();
        assert.ok(lease);
        return { renewBy: millis(lease.renew_by), expiresAt: millis(lease.expires_at) };
      }
      // The real Secret Driver timestamps its read with wall time. Move only the renewal clock.
      clock = Date.now();
      const deadline = millis(captured.deadline);
      const authorized = priorLease
        ? await progress(0)
        : { renewBy: deadline, expiresAt: deadline };
      if (priorLease) {
        assert.ok(authorized.renewBy > deadline);
        clock += 15_000;
      }
      f.observed.policyStatusUnavailable = true;
      const checksBefore = f.observed.policyStatusRequests;
      for (let bytes = 1; bytes <= 8; bytes += 1) {
        assert.deepEqual(await progress(bytes), authorized);
      }
      const outageChecks = f.observed.policyStatusRequests - checksBefore;
      t.diagnostic(
        `8 progress frames, ${outageChecks} gateway policy requests, both lease deadlines unchanged`,
      );
      assert.equal(outageChecks, 1, "an outage gets one policy request per retry interval");

      f.observed.policyStatusUnavailable = false;
      clock += 14_999;
      assert.deepEqual(await progress(9), authorized);
      assert.equal(f.observed.policyStatusRequests - checksBefore, 1);
      if (finish === "recover") {
        clock += 1;
        const recovered = await progress(10);
        assert.ok(recovered.renewBy > authorized.renewBy);
        assert.equal(f.observed.policyStatusRequests - checksBefore, 2);
      } else {
        const stopped = await f.request(
          "POST",
          `/namespaces/${f.namespace.id}/agents/${f.agent.id}/stop`,
        );
        assert.equal(stopped.status, 202);
        assert.equal(stopped.data.desiredRuntimeState, "stopped");
      }

      // Observe the complete gRPC stream at the verified peer, including its terminal status.
      const terminal = new Promise<{ code: number }>((resolve) =>
        peer.stream.once("status", resolve),
      );
      peer.stream.write({ response: upstream });
      const { code } = await terminal;
      const replies = peer.received.filter((frame) => frame.response);
      const delivered = Buffer.concat(replies.map((frame) => frame.response.body));
      t.diagnostic(
        `gRPC status ${code}, ${replies.length} protected response frames, ${delivered.length} protected body bytes`,
      );
      if (finish === "recover") {
        assert.equal(code, 0);
        assert.equal(replies.length, 1);
        assert.equal(replies[0].response.status, 200);
        assert.equal(replies[0].response.response_complete, true);
        assert.deepEqual(delivered, expected);
      } else {
        assert.equal(code, 7); // PERMISSION_DENIED
        assert.equal(replies.length, 0);
        assert.equal(delivered.length, 0);
        const controller: OpenClawController = f.controller;
        const audit = await controller.transact((unit) => unit.audit.list());
        assert.ok(
          audit.some(
            (event) =>
              event.details?.requestId === captured.request.context.request_id &&
              event.action === "openclaw.egress.authorize" &&
              event.details.phase === "during_response" &&
              event.details.code === "withdrawn",
          ),
        );
      }
    });
  }
}
