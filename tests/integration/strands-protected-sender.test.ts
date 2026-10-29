import assert from "node:assert/strict";
import { createServer } from "node:https";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { staticEgressFixture } from "../helpers/static-egress.mjs";
import {
  launchStrandsSender,
  sendThroughStrandsGateway,
} from "../helpers/strands-sender-client.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const binary = process.env.OCC_TEST_STRANDS_SENDER_BINARY;
const sensitiveValue = "untrusted-credential-must-not-be-classified";
// OpenAI Node 7.5.0 responses.create header shape, including Undici transport metadata.
// Keep this wire control runnable without installing the SDK in the workspace.
const sdkHeaders =
  [
    "Authorization: Bearer oce-placeholder",
    "Accept: application/json",
    "User-Agent: OpenAI/JS 7.5.0",
    "X-Stainless-Arch: x64",
    "X-Stainless-Lang: js",
    "X-Stainless-OS: Linux",
    "X-Stainless-Package-Version: 7.5.0",
    "X-Stainless-Retry-Count: 0",
    "X-Stainless-Runtime: node",
    "X-Stainless-Runtime-Version: v24.22.1",
    "Accept-Encoding: gzip, deflate, br",
    "Accept-Language: *",
    "Sec-Fetch-Mode: cors",
  ].join("\r\n") + "\r\n";

type Scenario = {
  name: string;
  outcome: "allow" | "withhold" | "deny";
  fault?: "withdraw" | "replace" | "lost reply" | "Box deny" | "authority unavailable";
  sdkWire?: boolean;
  untrustedHeader?: string;
};
const rejectedHeader = (name: string, untrustedHeader: string, sdkWire = true): Scenario => ({
  name,
  outcome: "deny",
  sdkWire,
  untrustedHeader,
});
const scenarios: readonly Scenario[] = [
  { name: "allow", outcome: "allow" },
  { name: "SDK wire", outcome: "allow", sdkWire: true },
  { name: "withdraw", outcome: "deny", fault: "withdraw" },
  { name: "replace", outcome: "withhold", fault: "replace" },
  { name: "lost reply", outcome: "withhold", fault: "lost reply" },
  { name: "Box deny", outcome: "deny", fault: "Box deny" },
  { name: "authority unavailable", outcome: "deny", fault: "authority unavailable" },
  rejectedHeader("x-goog-api-key", `x-goog-api-key: ${sensitiveValue}`),
  rejectedHeader("x-amz-security-token", `x-amz-security-token: ${sensitiveValue}`),
  rejectedHeader(
    "duplicate authorization",
    "Authorization: Bearer oce-placeholder\r\nauthorization: Bearer oce-placeholder",
    false,
  ),
  rejectedHeader("authorization", `authorization: Bearer ${sensitiveValue}`, false),
  rejectedHeader("cookie", `cookie: ${sensitiveValue}`),
  rejectedHeader("x-api-key", `x-api-key: ${sensitiveValue}`),
  rejectedHeader("unknown header", `x-unknown-client-field: ${sensitiveValue}`),
];

for (const scenario of scenarios) {
  test(
    `Box terminal sender: ${scenario.name}`,
    {
      skip: binary ? false : "Build the reference sender and set OCC_TEST_STRANDS_SENDER_BINARY",
      timeout: 60000,
    },
    async (t) => {
      const directory = await temporaryDirectory(t, "oce-sender-");
      let applicationBytes = 0;
      let accepted = 0;
      let resolutions = 0;
      const inspectSdk = scenario.outcome === "allow" && scenario.sdkWire;
      // The controlled origin counts decrypted bytes across every TLS connection.
      // Its lost-reply and replacement cases happen after a real request reaches it.
      const initialized = await staticEgressFixture(t, {
        resolutionFinished: async () => {
          resolutions++;
          if (scenario.fault === "withdraw") {
            await fixture.revoke();
          }
        },
        providerServer: (options, handler) => {
          const server = createServer(options, (request, response) => {
            accepted++;
            if (inspectSdk) {
              assert.deepEqual(Object.keys(request.headers).sort(), [
                "accept",
                "authorization",
                "content-length",
                "content-type",
                "host",
              ]);
              assert.equal(request.headers.authorization, "Bearer synthetic-key-initial");
              assert.doesNotMatch(
                JSON.stringify(request.headers),
                /oce-placeholder|OpenAI\/JS|stainless/,
              );
            }
            if (scenario.fault === "lost reply") {
              request.resume();
              request.on("end", () => request.socket.destroy());
            } else {
              if (scenario.fault === "replace") {
                const evidence = Reflect.get(fixture.observed, "evidence") as {
                  instance_id: string;
                };
                evidence.instance_id = "10000000-0000-4000-8000-000000000001";
              }
              void handler(request, response);
            }
          });
          server.on("secureConnection", (socket) =>
            socket.on("data", (bytes) => {
              applicationBytes += bytes.length;
            }),
          );
          return server;
        },
      });
      assert.ok("writeSenderInstallation" in initialized);
      const fixture: Extract<
        Awaited<ReturnType<typeof staticEgressFixture>>,
        { writeSenderInstallation: unknown }
      > = initialized;
      const { configPath, providerPort } = await fixture.writeSenderInstallation(directory);
      const policy = join(directory, "policy.dw");
      await writeFile(
        policy,
        `permit(principal, action == Box::Action::"net:connect", resource);
      ${scenario.fault === "Box deny" ? "forbid" : "permit"}(principal, action == Box::Action::"http:request", resource);`,
      );
      const gatewayPath = join(directory, "gateway.json");
      await writeFile(
        gatewayPath,
        JSON.stringify({
          sender: configPath,
          policy,
          history: join(directory, "history.redb"),
          trustDirectory: join(directory, "trust"),
          listen: "127.0.0.1:0",
          governedBox: fixture.installation.sandboxId,
          dns: [["provider.example.test", "127.0.0.1"]],
        }),
      );
      const gateway = await launchStrandsSender(t, binary!, gatewayPath);
      if (scenario.fault === "authority unavailable") {
        fixture.authority.forceShutdown();
      }
      const before = fixture.secretReads;
      const body = JSON.stringify({ model: "fixture-model", input: "hello", store: false });
      const headers = `${scenario.sdkWire ? sdkHeaders : ""}${scenario.untrustedHeader ? `${scenario.untrustedHeader}\r\n` : ""}`;
      const received = await sendThroughStrandsGateway(t, gateway, providerPort, headers, body);
      const diagnostic = gateway.diagnostics();
      assert.doesNotMatch(received, /synthetic-key-initial|untrusted-placeholder/);
      if (scenario.untrustedHeader) {
        assert.equal(resolutions, 0, "unsupported headers must never enter OCE classification");
        assert.ok("auditSink" in fixture);
        assert.doesNotMatch(JSON.stringify(fixture.auditSink.events), new RegExp(sensitiveValue));
        assert.doesNotMatch(diagnostic, new RegExp(sensitiveValue));
      }
      if (scenario.outcome === "allow") {
        assert.equal(accepted, 1, diagnostic);
        assert.ok(applicationBytes > 0);
        assert.match(received, /fixture answer/, diagnostic);
        assert.equal(fixture.secretReads, before + 1);
        assert.equal(fixture.providerRequests[0].authorization, "Bearer synthetic-key-initial");
        if (inspectSdk) {
          assert.equal(resolutions, 1);
          assert.ok("auditSink" in fixture);
          assert.doesNotMatch(
            JSON.stringify(fixture.auditSink.events),
            /oce-placeholder|OpenAI\/JS|stainless/,
          );
          assert.doesNotMatch(diagnostic, /oce-placeholder|OpenAI\/JS|stainless/);
          await gateway.stop();
          assert.ok(
            !(await readFile(join(directory, "history.redb"))).includes(
              Buffer.from("oce-placeholder"),
            ),
          );
        }
      } else if (scenario.outcome === "withhold") {
        assert.equal(accepted, 1, diagnostic);
        assert.ok(applicationBytes > 0);
        assert.doesNotMatch(received, /fixture answer/);
        assert.match(diagnostic, /no retry/);
      } else {
        assert.equal(accepted, 0, diagnostic);
        assert.equal(applicationBytes, 0, diagnostic);
        assert.doesNotMatch(received, /fixture answer/);
        assert.equal(fixture.secretReads, before + (scenario.fault === "withdraw" ? 1 : 0));
      }
    },
  );
}
