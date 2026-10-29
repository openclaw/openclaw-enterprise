import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:https";
import { connect } from "node:net";
import { connect as connectTls } from "node:tls";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { staticEgressFixture } from "../helpers/static-egress.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const binary = process.env.OCC_TEST_STRANDS_SENDER_BINARY;
const scenarios = [
  "allow",
  "withdraw",
  "replace",
  "lost reply",
  "Box deny",
  "authority unavailable",
  "x-goog-api-key",
  "x-amz-security-token",
  "duplicate authorization",
] as const;

for (const scenario of scenarios) {
  test(
    `Box terminal sender: ${scenario}`,
    {
      skip: binary ? false : "Build the reference sender and set OCC_TEST_STRANDS_SENDER_BINARY",
      timeout: 60000,
    },
    async (t) => {
      const directory = await temporaryDirectory(t, "oce-sender-");
      let applicationBytes = 0;
      let accepted = 0;
      let resolutions = 0;
      const sensitiveValue = "untrusted-credential-must-not-be-classified";
      const sensitive = [
        "x-goog-api-key",
        "x-amz-security-token",
        "duplicate authorization",
      ].includes(scenario);
      // The controlled origin counts decrypted bytes across every TLS connection.
      // Its lost-reply and replacement cases happen after a real request reaches it.
      const initialized = await staticEgressFixture(t, {
        resolutionFinished: async () => {
          resolutions++;
          if (scenario === "withdraw") {
            await fixture.revoke();
          }
        },
        providerServer: (options, handler) => {
          const server = createServer(options, (request, response) => {
            accepted++;
            if (scenario === "lost reply") {
              request.resume();
              request.on("end", () => request.socket.destroy());
            } else {
              if (scenario === "replace") {
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
      ${scenario === "Box deny" ? "forbid" : "permit"}(principal, action == Box::Action::"http:request", resource);`,
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
      const child = spawn(resolve(binary!), [gatewayPath], { stdio: ["ignore", "pipe", "pipe"] });
      let diagnostic = "";
      child.stderr.on("data", (chunk) => {
        diagnostic += chunk.toString();
      });
      t.after(async () => {
        t.diagnostic(diagnostic);
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGINT");
          await exited;
        }
      });
      const startup = await new Promise<{ port: number; ca: string }>((fulfill, reject) => {
        let output = "";
        child.on("error", reject);
        child.once("exit", () => reject(new Error(`sender exited: ${diagnostic}`)));
        child.stdout.on("data", (bytes) => {
          output += bytes.toString();
          if (output.includes("\n")) {
            try {
              fulfill(JSON.parse(output.split("\n")[0]!));
            } catch (error) {
              reject(error);
            }
          }
        });
      });
      if (scenario === "authority unavailable") {
        fixture.authority.forceShutdown();
      }
      const before = fixture.secretReads;
      const socket = connect(startup.port, "127.0.0.1");
      await once(socket, "connect");
      const connected = once(socket, "data");
      socket.write(
        `CONNECT provider.example.test:${providerPort} HTTP/1.1\r\nHost: provider.example.test:${providerPort}\r\n\r\n`,
      );
      assert.match((await connected)[0].toString(), /200/);
      const tls = connectTls({
        socket,
        servername: "provider.example.test",
        ca: await readFile(startup.ca),
      });
      t.after(() => tls.destroy());
      await once(tls, "secureConnect");
      const body = JSON.stringify({ model: "fixture-model", input: "hello", store: false });
      const response = new Promise<string>((fulfill, reject) => {
        let output = "";
        tls.on("data", (chunk) => {
          output += chunk.toString();
        });
        tls.on("end", () => fulfill(output));
        tls.on("error", reject);
        tls.setTimeout(25000, () => tls.destroy(new Error("response timeout")));
      });
      const untrusted =
        scenario === "duplicate authorization"
          ? `Authorization: ${sensitiveValue}\r\nAuthorization: ${sensitiveValue}\r\n`
          : sensitive
            ? `${scenario}: ${sensitiveValue}\r\n`
            : "";
      tls.write(
        `POST /v1/responses HTTP/1.1\r\nHost: provider.example.test:${providerPort}\r\n${untrusted}Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      const received = await response;
      assert.doesNotMatch(received, /synthetic-key-initial|untrusted-placeholder/);
      if (sensitive) {
        assert.equal(resolutions, 0, "unsupported headers must never enter OCE classification");
        assert.ok("auditSink" in fixture);
        assert.doesNotMatch(JSON.stringify(fixture.auditSink.events), new RegExp(sensitiveValue));
        assert.doesNotMatch(diagnostic, new RegExp(sensitiveValue));
      }
      if (scenario === "allow") {
        assert.equal(accepted, 1, diagnostic);
        assert.ok(applicationBytes > 0);
        assert.match(received, /fixture answer/, diagnostic);
        assert.equal(fixture.secretReads, before + 1);
        assert.equal(fixture.providerRequests[0].authorization, "Bearer synthetic-key-initial");
      } else if (scenario === "replace" || scenario === "lost reply") {
        assert.equal(accepted, 1, diagnostic);
        assert.ok(applicationBytes > 0);
        assert.doesNotMatch(received, /fixture answer/);
        assert.match(diagnostic, /no retry/);
      } else {
        assert.equal(accepted, 0, diagnostic);
        assert.equal(applicationBytes, 0, diagnostic);
        assert.doesNotMatch(received, /fixture answer/);
        assert.equal(fixture.secretReads, before + (scenario === "withdraw" ? 1 : 0));
      }
    },
  );
}
