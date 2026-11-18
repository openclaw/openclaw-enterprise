import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { text } from "node:stream/consumers";
import { appModule } from "../fixtures/repository-credentials/runtime.ts";
import { appFunction } from "../fixtures/repository-credentials/app-functions.ts";
import { createTestResourceScope } from "../fixtures/repository-credentials/resources.ts";
import { createTlsMaterial, listen } from "../fixtures/repository-credentials/process.ts";
import { serviceConfigurationData } from "../fixtures/repository-credentials/builders.ts";
import {
  observeTlsOrigin,
  receiveThroughFin,
} from "../fixtures/repository-credentials/socket-observer.ts";

type RuntimeModules = {
  "drivers/repo/github/access/routes": Pick<
    typeof import("../../apps/controller/src/drivers/repo/github/access/routes.ts"),
    "createRoutePolicy"
  >;
  "drivers/repo/access/transport/upstream": Pick<
    typeof import("../../apps/controller/src/drivers/repo/access/transport/upstream.ts"),
    "createUpstreamSender"
  >;
  "drivers/repo/access/transport/request": Pick<
    typeof import("../../apps/controller/src/drivers/repo/access/transport/request.ts"),
    "inspectRequestHead"
  >;
  "drivers/repo/access/transport/errors": Pick<
    typeof import("../../apps/controller/src/drivers/repo/access/transport/errors.ts"),
    "sendError"
  >;
};

function assertRuntimeExport<Path extends keyof RuntimeModules>(
  value: unknown,
  name: keyof RuntimeModules[Path],
): asserts value is RuntimeModules[Path] {
  assert.ok(typeof value === "object" && value !== null && name in value);
  assert.equal(typeof Reflect.get(value, name), "function");
}

async function runtimeExport<
  Path extends keyof RuntimeModules,
  Name extends keyof RuntimeModules[Path],
>(path: Path, name: Name): Promise<RuntimeModules[Path][Name]> {
  const value = await appModule(path);
  assertRuntimeExport<Path>(value, name);
  return value[name];
}

const createRoutePolicy = await runtimeExport(
  "drivers/repo/github/access/routes",
  "createRoutePolicy",
);
const createUpstreamSender = await runtimeExport(
  "drivers/repo/access/transport/upstream",
  "createUpstreamSender",
);
const inspectRequestHead = await runtimeExport(
  "drivers/repo/access/transport/request",
  "inspectRequestHead",
);
const sendError = await runtimeExport("drivers/repo/access/transport/errors", "sendError");
const createSystemClock = await appFunction("drivers/repo/access/clock", "createSystemClock");
const validateServiceConfig = await appFunction(
  "drivers/repo/access/configuration",
  "validateServiceConfig",
);

type OriginScenario = {
  body?: string;
  status?: number;
  declaration?: boolean;
  benignTrailer?: boolean;
  trailer?: boolean;
};
type MetadataCase = [name: string, scenario: OriginScenario, accepted?: true];
type ParsedRequest = {
  method: string | undefined;
  target: string | undefined;
  authorization: IncomingHttpHeaders["authorization"];
  body: string;
};
type ExchangeOutcome =
  import("../../apps/controller/src/drivers/repo/access/internal-contracts.ts").ExchangeOutcome;
type Profile = Parameters<typeof createRoutePolicy>[0]["profile"];

function portOf(server: Server): number {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

const target = "/repos/fixture/repository";
const identity = { id: 73, full_name: "fixture/repository" };
const credential = "Bearer synthetic-metadata-origin-only";
const request = (path = target, framing = "Content-Length: 0", body = "") =>
  `GET ${path} HTTP/1.1\r\nHost: gateway.example\r\nConnection: close\r\n${framing}\r\n\r\n${body}`;
function assertFixedResponse(raw: string, status: string, body: string) {
  const [head, receivedBody, ...extra] = raw.split("\r\n\r\n");
  assert.ok(head);
  const [receivedStatus, ...headers] = head.split("\r\n");
  assert.equal(receivedStatus, `HTTP/1.1 ${status}`);
  assert.deepEqual(
    headers.sort(),
    [
      "cache-control: no-store",
      "connection: close",
      `content-length: ${Buffer.byteLength(body)}`,
      "content-type: application/json",
    ].sort(),
  );
  assert.equal(receivedBody, body);
  assert.deepEqual(extra, []);
}

test(
  "protected repository metadata: local route and sender socket proof",
  { timeout: 15000 },
  async (t) => {
    const resources = createTestResourceScope(t);
    const tls = await createTlsMaterial(resources);
    const clock = createSystemClock();
    const config = validateServiceConfig(
      serviceConfigurationData({ limits: { apiResponseBytes: 1024 } }),
    );
    let scenario: OriginScenario = {};
    const parsedRequests: ParsedRequest[] = [];
    const originServer = createServer(async (req, res) => {
      parsedRequests.push({
        method: req.method,
        target: req.url,
        authorization: req.headers.authorization,
        body: await text(req),
      });
      const body =
        scenario.body ??
        JSON.stringify({ ...identity, description: credential, extra: "provider-extra" });
      res.writeHead(scenario.status ?? 200, {
        "content-type": "application/json",
        "cache-control": credential,
        "x-ratelimit-resource": credential,
        ...(scenario.declaration ? { trailer: "x-declared" } : {}),
      });
      res.write(body);
      if (scenario.benignTrailer) {
        res.addTrailers({ "x-declared": "benign" });
      }
      if (scenario.trailer) {
        res.addTrailers({ "x-forbidden-last": credential });
      }
      res.end();
    });
    await listen(resources, originServer);
    const observed = await observeTlsOrigin(resources, tls, portOf(originServer));
    const policy = (profile: Profile) =>
      createRoutePolicy({
        repository: identity.full_name,
        repositoryId: String(identity.id),
        profile,
        gatewayOrigin: "https://gateway.example",
        gitOrigin: observed.origin,
        apiOrigin: observed.origin,
        limits: config.limits,
      });
    let selected = policy("metadata-read");
    const outcomes: ExchangeOutcome[] = [];
    const gateway = createServer(async (req, res) => {
      res.sendDate = false;
      const parsed = inspectRequestHead(req, {
        authority: "gateway.example",
        receivedMonoMs: clock.monotonicNow(),
        headerBytes: 32768,
        headerPairs: 64,
        targetBytes: 8192,
      });
      if (parsed.kind === "denied") {
        req.resume();
        sendError(res, parsed.status, parsed.code);
        return;
      }
      const plan = selected.plan(parsed.head);
      if ("kind" in plan) {
        req.resume();
        sendError(res, plan.status, plan.code);
        return;
      }
      const tracked: Promise<void>[] = [];
      const sender = createUpstreamSender({
        request: req,
        response: res,
        head: parsed.head,
        trustedUpstreamOrigins: new Set([observed.origin]),
        clock,
        upstreamCa: tls.ca,
      });
      const outcome = await sender(
        { plan, headers: { ...plan.requestHeaders, authorization: credential } },
        {
          signal: new AbortController().signal,
          deadlineMonoMs: clock.monotonicNow() + 5000,
          // Test dispatch gate only: no session, IAM, sibling identity or joined authorization proof.
          gate: {
            dispatch(_cancel, open) {
              return open();
            },
            track(io) {
              tracked.push(io);
            },
          },
        },
      );
      await Promise.all(tracked);
      outcomes.push(outcome);
      if (outcome.kind !== "completed") {
        sendError(
          res,
          502,
          outcome.kind === "not-dispatched" ? "unavailable" : "exchange-uncertain",
        );
      }
    });
    await listen(resources, gateway);
    const port = portOf(gateway);
    const verifyOrigin = async (index: number) => {
      assert.ok(observed.connections[index], "origin connection was observed");
      const wire = await observed.connections[index];
      assert.ok(wire.request.startsWith(`GET ${target} HTTP/1.1\r\n`));
      assert.ok(wire.request.includes(`authorization: ${credential}\r\n`));
      assert.equal(wire.request.split("\r\n\r\n")[1], "");
      assert.deepEqual(parsedRequests[index], {
        method: "GET",
        target,
        authorization: credential,
        body: "",
      });
      return wire;
    };
    await t.test("two client processes receive only configured identity", async () => {
      const start = observed.connections.length;
      const observer = new URL(
        "../fixtures/repository-credentials/socket-observer.ts",
        import.meta.url,
      );
      const script = `import { receiveThroughFin } from ${JSON.stringify(observer.href)};
        const [port, req] = process.argv.slice(1);
        process.stdout.write(await receiveThroughFin(Number(port), req));`;
      const client = () =>
        promisify(execFile)(
          process.execPath,
          ["--input-type=module", "-e", script, String(port), request()],
          { timeout: 5000 },
        );
      const recipients = await Promise.all([client(), client()]);
      for (const [index, { stdout: raw }] of recipients.entries()) {
        await verifyOrigin(start + index);
        assertFixedResponse(raw, "200 OK", JSON.stringify(identity));
      }
    });
    await t.test("changed target and GET bodies never reach origin", async () => {
      const before = observed.connections.length;
      for (const wire of [
        request("/repos/other/repository"),
        request(target, "Content-Length: 1", "x"),
        request(target, "Transfer-Encoding: chunked", "1\r\nx\r\n0\r\n\r\n"),
      ]) {
        assert.match(await receiveThroughFin(port, wire), /^HTTP\/1.1 400 Bad Request\r\n/);
      }
      assert.equal(observed.connections.length, before);
      assert.equal(parsedRequests.length, before);
    });
    const cases: MetadataCase[] = [
      ["valid identity with zero actual trailers", { body: JSON.stringify(identity) }, true],
      // GitHub answers with its own spelling; the configured one is released (finding 2239).
      [
        "GitHub's spelling of the full name",
        { body: JSON.stringify({ ...identity, full_name: "Fixture/Repository" }) },
        true,
      ],
      [
        "GitHub's all-caps spelling of the full name",
        { body: JSON.stringify({ ...identity, full_name: "FIXTURE/REPOSITORY" }) },
        true,
      ],
      ["a declaration alone is not an actual trailer", { declaration: true }, true],
      ["undeclared last actual trailer", { trailer: true, body: JSON.stringify(identity) }],
      [
        "last actual trailer beyond declaration",
        { trailer: true, declaration: true, body: JSON.stringify(identity) },
      ],
      ["non-200 success", { status: 201 }],
      ["wrong repository id", { body: JSON.stringify({ ...identity, id: 74 }) }],
      ["string repository id", { body: JSON.stringify({ ...identity, id: "73" }) }],
      ["wrong full name", { body: JSON.stringify({ ...identity, full_name: "other/repository" }) }],
      [
        "full name with a suffix",
        { body: JSON.stringify({ ...identity, full_name: "Fixture/Repository.git" }) },
      ],
      ["non-string full name", { body: JSON.stringify({ ...identity, full_name: null }) }],
      ["malformed JSON", { body: "{" }],
      [
        "response byte overflow",
        { body: JSON.stringify({ ...identity, extra: "x".repeat(1024) }) },
      ],
    ];
    for (const [name, value, accepted = false] of cases) {
      await t.test(`${name}: exact response through recipient FIN`, async () => {
        scenario = value;
        const index = observed.connections.length;
        const raw = await receiveThroughFin(port, request());
        const wire = await verifyOrigin(index);
        assert.equal(observed.connections.length, index + 1, "exactly one origin connection");
        assert.equal(/\r\ntrailer: /i.test(wire.response), Boolean(value.declaration));
        if (accepted) {
          assert.ok(wire.response.endsWith("0\r\n\r\n"), "no actual trailers on the origin socket");
          assertFixedResponse(raw, "200 OK", JSON.stringify(identity));
          return;
        }
        if (value.trailer) {
          assert.ok(
            wire.response.endsWith(`0\r\nx-forbidden-last: ${credential}\r\n\r\n`),
            "independent origin socket observer reached the only actual trailer",
          );
        }
        // Exact local error bytes distinguish a safe error from leaked provider headers/body.
        const body = '{"error":{"code":"exchange-uncertain"}}';
        assertFixedResponse(raw, "502 Bad Gateway", body);
        assert.equal(outcomes.at(-1)?.kind, "possibly-dispatched");
      });
    }
    await t.test("general git-read retains descriptions with a benign actual trailer", async () => {
      const description = "Fixture repository description";
      scenario = {
        declaration: true,
        benignTrailer: true,
        body: JSON.stringify({ ...identity, description }),
      };
      selected = policy("git-read");
      const index = observed.connections.length;
      const raw = await receiveThroughFin(port, request());
      const wire = await verifyOrigin(index);
      assert.ok(wire.response.endsWith("0\r\nx-declared: benign\r\n\r\n"));
      assert.match(raw, /^HTTP\/1.1 200 OK\r\n/);
      const body = raw.split("\r\n\r\n")[1];
      assert.ok(body);
      const response: unknown = JSON.parse(body);
      assert.ok(typeof response === "object" && response !== null && "description" in response);
      assert.equal(response.description, description);
    });
  },
);
