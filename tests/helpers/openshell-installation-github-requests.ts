import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { buffer } from "node:stream/consumers";
import type { TestContext } from "node:test";
import type { preparedStandingGitPeer } from "./prepared-standing-git-peer.ts";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import { fixtureRepository } from "../fixtures/repository-credentials/github.mjs";
import { cleanEnvironment } from "../fixtures/repository-credentials/process.mjs";

type Peer = Awaited<ReturnType<typeof preparedStandingGitPeer>>;

/** Continue the real standing journey on its successor token. The controlled sender owns both
 * the inspected request and its one send; Git and GitHub fixtures are HTTPS on loopback. */
export async function exerciseInstallationRequests(
  t: TestContext,
  peer: Peer,
  {
    inspected,
    evaluateRequest,
    value,
    cwd,
    oid,
  }: {
    inspected(): ReturnType<Peer["input"]>;
    evaluateRequest(input: object): Promise<{ decision?: number }>;
    value: string;
    cwd: string;
    oid: string;
  },
) {
  const { httpsRequest, apiOrigin, tls, authorize } = peer.installationTransport;
  const repository = "fixture/.github";
  const git = startGitSmartHttpFixture as (
    t: TestContext,
    options: object,
  ) => ReturnType<typeof startGitSmartHttpFixture>;
  const second = await git(t, { repository, tls, authorize });
  const originCalls = () => peer.originCalls() + second.traffic().requests + peer.gh.trace.length;
  const apiHost = "api.github.com";
  async function exchange(
    host: string,
    method: string,
    target: string,
    contentType?: string,
    body?: Buffer,
    expected: "allow" | "deny" | "authorize-only" = "allow",
    port = 443,
    scheme = "https",
  ) {
    const wire = inspected();
    const [path, query = ""] = target.split("?");
    const headers = contentType ? { "content-type": contentType } : undefined;
    const before = originCalls();
    const result = await evaluateRequest({
      ...wire,
      body,
      target: { method, scheme, host, port, path, query },
      headers: Object.entries(headers ?? {}).map(([name, value]) => ({ name, value })),
    });
    if (expected === "deny") {
      assert.equal(result.decision, 2, "refused " + method + " " + host + ":" + port + target);
      assert.equal(originCalls(), before);
      return Buffer.alloc(0);
    }
    assert.equal(result.decision, 1, method + " " + host + target);
    if (expected === "authorize-only") {
      return Buffer.alloc(0);
    }
    assert.ok(host === apiHost || host === "github.com");
    const api = host === apiHost;
    const url = new URL(target, api ? apiOrigin : second.origin);
    assert.equal(url.hostname, "127.0.0.1");
    const authorization = api
      ? "Bearer " + value
      : "Basic " + Buffer.from("x-access-token:" + value).toString("base64");
    return await new Promise<Buffer>((resolve, reject) => {
      httpsRequest(
        url,
        {
          ca: tls.ca,
          // Connect only to the local fixture and verify its actual certificate identity.
          servername: "credentials.example.test",
          agent: false,
          method,
          signal: AbortSignal.timeout(5000),
          headers: {
            ...headers,
            host,
            authorization,
            ...(body && { "content-length": body.length }),
          },
        },
        (res) => {
          void buffer(res)
            .then((bytes) => {
              assert.equal(res.statusCode, 200, "fixture accepted the installed credential");
              resolve(bytes);
            })
            .catch(reject);
        },
      )
        .on("error", reject)
        .end(body);
    });
  }
  // Replay the new destination a client would present after a cross-host redirect. OCE sees
  // the destination, not how it was discovered; it authorizes neither it nor a spoofed Host.
  for (const [host, path, port, scheme] of [
    ["other.example.test", "/graphql"],
    ["github.com", "/graphql"],
    [apiHost, "/graphql", 444],
    [apiHost, "/graphql", 443, "http"],
    [apiHost, "/app/installations/41/access_tokens"],
    [apiHost, "/installation/token"],
    [apiHost, "/repos/fixture/repo/..%2f..%2fapp/installations"],
    [apiHost, "//other.example.test/graphql"],
  ] as const) {
    await exchange(host, "POST", path, "application/json", Buffer.from("{}"), "deny", port, scheme);
  }
  const prefix = "/" + repository + ".git/";
  const adv = await exchange("github.com", "GET", prefix + "info/refs?service=git-receive-pack");
  assert.match(adv.toString(), /service=git-receive-pack/);
  const options = { env: cleanEnvironment(), timeout: 5000 };
  assert.equal(
    spawnSync("git", ["cat-file", "-e", oid], { ...options, cwd: second.bare }).status,
    1,
    "the object fetched from the first repository is absent at the second",
  );
  const pack = spawnSync("git", ["pack-objects", "--stdout", "--revs"], {
    ...options,
    cwd,
    input: oid + "\n",
  });
  assert.equal(pack.status, 0);
  const ref = "refs/heads/installation-feature";
  const command = "0".repeat(40) + " " + oid + " " + ref + "\0report-status\n";
  const pkt = (command.length + 4).toString(16).padStart(4, "0") + command + "0000";
  const pushed = await exchange(
    "github.com",
    "POST",
    prefix + "git-receive-pack",
    "application/x-git-receive-pack-request",
    Buffer.concat([Buffer.from(pkt), pack.stdout]),
  );
  assert.match(pushed.toString(), /unpack ok/);
  assert.equal(await second.ref(ref), oid);
  const metadata = await exchange(apiHost, "GET", "/repos/" + fixtureRepository);
  assert.equal(JSON.parse(metadata.toString()).full_name, fixtureRepository);
  // The fixture has no Actions service. Check authorization of the actual bodyless POST;
  // GitHub would decide whether the installation can rerun this workflow.
  const rerun = "/repos/" + fixtureRepository + "/actions/runs/42/rerun";
  await exchange(apiHost, "POST", rerun, undefined, undefined, "authorize-only");
  await exchange(apiHost, "POST", "/graphql", undefined, undefined, "deny");
  const graph = Buffer.from(JSON.stringify({ query: "query { viewer { login } }" }));
  const viewer = await exchange(apiHost, "POST", "/graphql", "application/json", graph);
  assert.equal(JSON.parse(viewer.toString()).data.viewer.login, "fixture-bot");
  t.diagnostic(
    "Git pack from first private repository pushed to a new branch in the second; authenticated REST and GraphQL",
  );
  return { originCalls };
}
