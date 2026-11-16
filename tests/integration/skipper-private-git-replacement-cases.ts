import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent } from "node:https";
import { connect } from "node:net";
import { text } from "node:stream/consumers";
import test from "node:test";
import { connect as connectTls } from "node:tls";
import { startSkipperPrivateGitOrigin } from "../fixtures/skipper-private-git-origin.mjs";
import { isRecord } from "../helpers/egress-observation-values.ts";
import { waitUntil } from "../helpers/wait-for.ts";

type RequestOptions = { agent: Agent };
type ReplacementRequest = (
  target: { origin: string; tls: { ca: Buffer } },
  method: "POST" | "GET" | "DELETE",
  path: string,
  authorization?: string,
  body?: { repository_ids: number[]; permissions: { metadata: "read"; contents: "write" } },
  options?: RequestOptions,
) => Promise<unknown>;

type ReplacementOrigin = {
  origin: string;
  installationId: string;
  repository: string;
  tls: unknown;
  close(): Promise<unknown>;
  createAppJwt(): string;
  snapshot(): {
    connections: number;
    tokens: ReadonlyArray<{ index: number }>;
    endpoints: unknown;
  };
  observeReplacementOrigin(
    firstIndex: number,
    replacementIndex: number,
  ): (completedWitnesses?: number) => void;
  probeIssuedGit(index: number): Promise<unknown>;
  refuseTokenRetirement(index: number): void;
};

function requestStatus(response: unknown): number {
  assert.ok(isRecord(response) && typeof response.status === "number");
  return response.status;
}

export function registerSkipperPrivateGitReplacementCases(api: ReplacementRequest): void {
  test("replacement permits only the original B credential's first issuer retirement", async (t) => {
    const origin: ReplacementOrigin = await startSkipperPrivateGitOrigin({
      witnessIssuedGit: true,
    });
    t.after(async () => {
      await origin.close();
    });
    const originTls = origin.tls;
    assert.ok(isRecord(originTls) && Buffer.isBuffer(originTls.ca));
    const ca = originTls.ca;
    const target = { origin: origin.origin, tls: { ca } };
    const issue = async () => {
      const response = await api(
        target,
        "POST",
        `/app/installations/${origin.installationId}/access_tokens`,
        `Bearer ${origin.createAppJwt()}`,
        { repository_ids: [73], permissions: { metadata: "read", contents: "write" } },
      );
      assert.ok(isRecord(response));
      assert.equal(response.status, 201);
      const body = response.body;
      assert.ok(isRecord(body) && typeof body.token === "string" && body.token.length > 0);
      const issued = origin.snapshot().tokens.at(-1);
      assert.ok(issued && Number.isSafeInteger(issued.index) && issued.index > 0);
      return { auth: "Bearer " + body.token, index: issued.index };
    };
    const a = await issue();
    const b = await issue();
    const observe = () => origin.observeReplacementOrigin(a.index, b.index);
    const revoke = async (auth: string, options?: RequestOptions) =>
      requestStatus(await api(target, "DELETE", "/installation/token", auth, undefined, options));
    const denied = (check: () => void) => assert.throws(check, { code: "ERR_ASSERTION" });
    const clean = observe();
    clean();
    assert.equal(await origin.probeIssuedGit(a.index), 200);
    denied(clean);
    clean(1);
    const git = observe();
    assert.equal(await origin.probeIssuedGit(b.index), 200);
    denied(() => git(1));
    const discovery = `/${origin.repository}.git/info/refs?service=git-upload-pack`;
    const requests = [
      [discovery, b.auth, 200],
      [discovery, undefined, 401],
      ["/unrecognized", a.auth, 404],
    ] as const;
    for (const [path, auth, status] of requests) {
      const check = observe();
      assert.equal(requestStatus(await api(target, "GET", path, auth)), status);
      denied(check);
    }
    origin.refuseTokenRetirement(a.index);
    const wrong = observe();
    assert.equal(await revoke(a.auth), 503);
    denied(wrong);
    const unknown = observe();
    assert.equal(await revoke("Bearer invalid"), 401);
    denied(unknown);
    const issuance = observe();
    await issue();
    denied(issuance);

    const url = new URL(origin.origin);
    const options = { host: url.hostname, port: Number(url.port) };
    // The TLS connection already belongs to the baseline. Only the parsed request
    // can distinguish this traffic from an idle connection.
    const unexpectedRequests = [
      [
        "unsupported expectation",
        "GET / HTTP/1.1\r\nHost: fixture.invalid\r\nExpect: unsupported",
        417,
      ],
      ["missing Host", "GET / HTTP/1.1", 400],
      ["CONNECT", "CONNECT fixture.invalid:443 HTTP/1.1\r\nHost: fixture.invalid", undefined],
      [
        "upgrade",
        "GET / HTTP/1.1\r\nHost: fixture.invalid\r\nConnection: upgrade\r\nUpgrade: example",
        404,
      ],
    ] as const;
    for (const [name, headers, status] of unexpectedRequests) {
      await t.test(name, { timeout: 5000 }, async (t) => {
        const socket = connectTls({ ...options, ca });
        t.after(() => {
          socket.destroy();
        });
        await once(socket, "secureConnect");
        const check = observe();
        check();
        socket.setEncoding("ascii");
        let response = "";
        socket.on("data", (chunk: string) => {
          response += chunk;
        });
        socket.end(headers + "\r\n\r\n");
        await once(socket, "end");
        if (status === undefined) {
          assert.equal(response, "");
        } else {
          assert.ok(response.startsWith(`HTTP/1.1 ${status} `));
        }
        denied(check);
      });
    }
    // B's first HTTP request can use TLS accepted before observation. A bare
    // connection opened afterward must still fail even though the totals rise by one each.
    const tls = connectTls({ ...options, ca });
    t.after(() => {
      tls.destroy();
    });
    await once(tls, "secureConnect");
    const withExtra = observe();
    const prior = origin.snapshot().connections;
    const raw = connect(options);
    t.after(() => {
      raw.destroy();
    });
    await once(raw, "connect");
    await waitUntil(
      "extra raw connection accepted",
      () => origin.snapshot().connections === prior + 1,
      3000,
    );
    const preconnected = observe();
    const agent = new Agent();
    t.after(() => agent.destroy());
    agent.createConnection = () => tls;
    assert.equal(await revoke(b.auth, { agent }), 204);
    preconnected();
    denied(withExtra);
    assert.equal(await revoke(b.auth), 401);
    denied(preconnected);

    const next = await issue();
    const fresh = origin.observeReplacementOrigin(a.index, next.index);
    assert.equal(await revoke(next.auth), 204);
    fresh();

    const pipelined = await issue();
    const checkPipeline = origin.observeReplacementOrigin(a.index, pipelined.index);
    const pipeline = connectTls({ ...options, ca });
    t.after(() => {
      pipeline.destroy();
    });
    await once(pipeline, "secureConnect");
    const pipelineResponse = text(pipeline);
    pipeline.write(
      `DELETE /installation/token HTTP/1.1\r\nHost: fixture.invalid\r\nAuthorization: ${pipelined.auth}\r\n\r\n` +
        "GET /unrecognized HTTP/1.1\r\nHost: fixture.invalid\r\nConnection: close\r\n\r\n",
    );
    // The client sees the retirement succeed and the second request refused on the same socket.
    const wireResponse = await pipelineResponse;
    assert.deepEqual(wireResponse.match(/^HTTP\/1\.1 \d{3} /gm), [
      "HTTP/1.1 204 ",
      "HTTP/1.1 503 ",
    ]);
    const { endpoints } = origin.snapshot();
    assert.ok(isRecord(endpoints));
    assert.equal(endpoints["other:503"], 1);
    denied(checkPipeline);
  });
}
