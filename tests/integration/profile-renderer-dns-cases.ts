import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { codexInput } from "./profile-renderer-inputs.ts";
import { repository, helmSkip, helmTemplate, renderCli } from "./profile-renderer-fixture.ts";

async function startDnsFixture(t: TestContext, records: Record<string, string[]>) {
  const directory = mkdtempSync(join(tmpdir(), "oce-profile-dns-"));
  const queriesPath = join(directory, "queries.txt");
  writeFileSync(queriesPath, "");
  // The CLI is synchronous in these tests; a separate process must answer its
  // real DNS queries while the test runner is blocked waiting for rendering.
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { createSocket } from "node:dgram";
        import { appendFileSync } from "node:fs";
        const socket = createSocket("udp4");
        socket.on("message", (query, peer) => {
          let end = 12;
          const labels = [];
          while (query[end] !== 0) {
            const length = query[end++];
            labels.push(query.subarray(end, end + length).toString());
            end += length;
          }
          const hostname = labels.join(".");
          appendFileSync(${JSON.stringify(queriesPath)}, hostname + "\\n");
          const records = ${JSON.stringify(records)};
          const addresses = records[hostname];
          const header = Buffer.alloc(12);
          query.copy(header, 0, 0, 2);
          header.writeUInt16BE(addresses ? 0x8180 : 0x8183, 2);
          header.writeUInt16BE(1, 4);
          header.writeUInt16BE(addresses?.length ?? 0, 6);
          const answers = (addresses ?? []).map((address) => {
            const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 0, 0, 0, 0]);
            Buffer.from(address.split(".").map(Number)).copy(answer, 12);
            return answer;
          });
          socket.send(Buffer.concat([header, query.subarray(12, end + 5), ...answers]), peer.port, peer.address);
        });
        socket.bind(0, "127.0.0.1", () => process.send(socket.address().port));
        process.on("disconnect", () => socket.close());
      `,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  t.after(async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) }).then(
          () => undefined,
        );
        child.kill("SIGKILL");
        await exited;
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const [port]: unknown[] = await Promise.race([
    once(child, "message", { signal: AbortSignal.timeout(5000) }).then(
      (message: unknown[]) => message,
    ),
    once(child, "exit").then(() => {
      throw new Error("DNS fixture exited before listening");
    }),
  ]);
  assert.ok(typeof port === "number", "expected the DNS fixture port");
  return { directory, queriesPath, server: `127.0.0.1:${port}` };
}

export function registerDnsCases(): void {
  test(
    "hosted Codex profiles render without resolving provider addresses",
    { skip: helmSkip },
    async (t) => {
      // Control-plane egress is unrestricted; rendering must not depend on operator-side DNS snapshots.
      const dns = await startDnsFixture(t, {});
      const output = renderCli("codex", codexInput(), dns.directory, repository, dns.server);
      assert.equal(output.preflight.ok, true);
      assert.equal(readFileSync(dns.queriesPath, "utf8"), "");
      assert.doesNotMatch(output.values, /modelDiscoveryCidrs|providerCidr/);
      assert.match(helmTemplate(output), /name: openclaw-enterprise-control-plane-egress/);
    },
  );
}
