import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { signComputeRepositoryGitProbe } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import {
  HARNESS_EGRESS_ENROLLMENT_HELPER,
  HARNESS_EGRESS_ENROLLMENT_PATH,
  HARNESS_REPOSITORY_GIT_ENROLLMENT_HELPER,
} from "../../apps/controller/src/drivers/compute/harness-egress-enrollment.ts";
import { reservePort, reservedPortArgs } from "../helpers/available-port.ts";
import { harnessTlsFixture } from "../helpers/harness-tls.ts";
import { signedLeaf } from "../helpers/certificates.ts";
import { listen } from "../helpers/listen.ts";

type ProbeScenario = {
  name: string;
  repositoryProbe?: boolean;
  connectRefused?: boolean;
  invalidJson?: boolean;
  body?: Record<string, unknown>;
  status?: number;
  expected?: { error: string; code?: number };
};

// Run the generated listener and its unmodified curl against an owned loopback proxy.
// This covers startup diagnostics, not installed supervisor policy or production egress.
test(
  "held enrollment distinguishes probe failures without exposing proxy output or retrying",
  { timeout: 30000 },
  async (t) => {
    const { directory, authority, rootCertificatePath } = await harnessTlsFixture(t);
    const leaf = await signedLeaf(directory, authority, {
      name: "github-probe",
      commonName: "Fixture endpoint",
      subjectAltName: "DNS:github.com",
      keyPem: undefined,
      days: 1,
    });
    const refusal = {
      error: "middleware_denied",
      middleware: "oce-prepared-git",
      reason_code: "oce_hook_" + "a".repeat(36),
    };
    const repositoryGitProbePath = "/example/project.git/info/refs";
    const scenarios: ProbeScenario[] = [
      {
        name: "CONNECT refused",
        connectRefused: true,
        expected: { error: "probe_process_failed", code: 56 },
      },
      {
        name: "invalid proxy JSON",
        invalidJson: true,
        expected: { error: "probe_response_invalid" },
      },
      {
        name: "unexpected denial",
        body: {},
        status: 409,
        expected: { error: "preview_not_observed" },
      },
      { name: "valid denial", body: refusal, status: 200 },
      { name: "exact repository denial", repositoryProbe: true, body: refusal, status: 200 },
    ];
    for (const scenario of scenarios) {
      await t.test(scenario.name, async (t) => {
        const privateText = "private-proxy-response-" + randomUUID();
        let connections = 0;
        let requests = 0;
        let received: { url: string | undefined; nonce: string | string[] | undefined } | undefined;
        const endpoint = httpsServer({ key: leaf.key, cert: leaf.cert }, (request, response) => {
          requests++;
          received = { url: request.url, nonce: request.headers["x-oce-git-startup-probe"] };
          response.writeHead(403, { "content-type": "application/json" });
          response.end(scenario.invalidJson ? privateText : JSON.stringify(scenario.body));
        });
        const endpointPort = await listen(t, endpoint);
        const proxy = httpServer();
        proxy.on("connect", (request, local, head) => {
          connections++;
          local.on("error", () => local.destroy());
          if (scenario.connectRefused || request.url !== "github.com:443") {
            local.end(
              "HTTP/1.1 403 Forbidden\r\nContent-Length: " +
                privateText.length +
                "\r\n\r\n" +
                privateText,
            );
            return;
          }
          const upstream = createConnection({ host: "127.0.0.1", port: endpointPort });
          local.once("error", () => upstream.destroy());
          local.once("close", () => upstream.destroy());
          upstream.once("error", () => local.destroy());
          upstream.once("connect", () => {
            local.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) {
              upstream.write(head);
            }
            local.pipe(upstream);
            upstream.pipe(local);
          });
        });
        const proxyPort = await listen(t, proxy);
        const reservation = await reservePort({ host: "0.0.0.0" });
        t.after(() => reservation.release());
        const transport = "synthetic-enrollment-transport";
        const revisionId = "diagnostic-revision";
        const enrollment = {
          inference: false,
          routeCount: 1,
          plan: { id: "plan", generation: 1 },
          execution: {
            installationId: "installation",
            namespaceId: "namespace",
            agentId: "agent",
            servicePrincipalId: "principal",
            revisionId,
            executionId: "execution",
          },
          repositoryGitAuthorization: "online-request",
          ...(scenario.repositoryProbe && { repositoryGitProbePath }),
        };
        const { publicKey, privateKey } = generateKeyPairSync("ed25519");
        const child = spawn(
          process.execPath,
          [
            ...reservedPortArgs(reservation),
            "--input-type=commonjs",
            "-e",
            "const isPlainObject = v => !!v && Object.getPrototypeOf(v) === Object.prototype;\n" +
              (scenario.repositoryProbe
                ? HARNESS_REPOSITORY_GIT_ENROLLMENT_HELPER
                : HARNESS_EGRESS_ENROLLMENT_HELPER) +
              "\nwaitForHarnessEgressEnrollment(" +
              JSON.stringify(enrollment) +
              ").catch(() => process.exitCode = 1);",
          ],
          {
            env: {
              APP_TOKEN_SHA: createHash("sha256").update(transport).digest("hex"),
              APP_SERVER_PORT: String(reservation.port),
              OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID: revisionId,
              OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY: publicKey
                .export({ type: "spki", format: "der" })
                .toString("base64url"),
              https_proxy: "http://127.0.0.1:" + proxyPort,
              CURL_CA_BUNDLE: rootCertificatePath,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk;
        });
        const exited = once(child, "exit");
        t.after(async () => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill();
            await exited;
          }
        });
        const url = "http://127.0.0.1:" + reservation.port + HARNESS_EGRESS_ENROLLMENT_PATH;
        const headers = {
          authorization: "Bearer " + transport,
          "content-type": "application/json",
        };
        let challenge: { startupId: string } | undefined;
        const deadline = Date.now() + 5000;
        while (!challenge && Date.now() < deadline) {
          try {
            const response = await fetch(url, { headers, signal: AbortSignal.timeout(300) });
            if (response.ok) {
              challenge = await response.json();
            }
          } catch {
            // The reserved port can reset connections until the generated listener binds.
          }
          if (!challenge) {
            await delay(25);
          }
        }
        assert.ok(challenge, "generated enrollment listener must start");
        await reservation.release();
        const startupId = challenge.startupId;
        const probePath = scenario.repositoryProbe
          ? repositoryGitProbePath
          : "/example/project.git/oce-observe-request/" + "b".repeat(32) + ".git/info/refs";
        const probeNonce = scenario.repositoryProbe ? "c".repeat(32) : undefined;
        const probeSignature =
          probeNonce === undefined
            ? undefined
            : signComputeRepositoryGitProbe(privateKey, startupId, probePath, probeNonce);
        const probe = (
          nonce: string | undefined,
          path = probePath,
          signature: string | null = probeSignature ?? null,
        ) =>
          fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              startupId,
              probePath: path,
              probeNonce: nonce,
              probeSignature: signature ?? undefined,
            }),
            signal: AbortSignal.timeout(15000),
          });
        if (scenario.repositoryProbe) {
          // A bearer holder can learn the path and startup ID. Substituting a valid-looking
          // nonce must leave the only attempt available for the signed probe.
          const incorrectNonce = "d".repeat(32);
          const rejected = await probe(incorrectNonce);
          assert.equal(rejected.status, 409);
          assert.deepEqual(await rejected.json(), { error: "stale_probe" });
          assert.equal(connections, 0);
          assert.equal(requests, 0);
          assert.equal((await probe(probeNonce, probePath, null)).status, 409);
          assert.equal((await probe("wrong")).status, 409);
          assert.equal((await probe(probeNonce, probePath + "?extra=1")).status, 409);
          assert.equal((await probe(probeNonce, "/other/project.git/info/refs")).status, 409);
          const legacyProbe = "/oce-observe-request/" + "b".repeat(32) + ".git/info/refs";
          assert.equal((await probe(undefined, legacyProbe)).status, 409);
        } else {
          // Legacy enrollment must refuse a repository discovery probe before curl.
          assert.equal((await probe("c".repeat(32), repositoryGitProbePath)).status, 409);
        }
        assert.equal(connections, 0);
        assert.equal(requests, 0);
        const response = await probe(probeNonce);
        assert.equal(response.status, scenario.status ?? 400);
        const result = await response.json();
        assert.deepEqual(
          result,
          scenario.expected ?? {
            startupId,
            probePath,
            ...(probeNonce !== undefined && { probeNonce }),
            reasonCode: refusal.reason_code,
          },
        );
        assert.equal(connections, 1);
        assert.equal(requests, scenario.connectRefused ? 0 : 1);
        if (!scenario.connectRefused) {
          assert.deepEqual(received, {
            url: probePath + "?service=git-upload-pack",
            nonce: probeNonce,
          });
        }
        // Even a failed probe consumes the one-use challenge and keeps startup held.
        assert.deepEqual(await (await probe(probeNonce)).json(), { error: "stale_probe" });
        assert.equal(connections, 1);
        assert.equal((await fetch(url, { headers })).status, 200);
        assert.ok(!JSON.stringify(result).includes(privateText));
        assert.ok(!output.includes(privateText));
        assert.ok(!output.includes(transport));
        assert.ok(!output.includes(probePath));
      });
    }
  },
);
