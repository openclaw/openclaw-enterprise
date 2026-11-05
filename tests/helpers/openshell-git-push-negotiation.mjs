import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { request } from "node:https";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import {
  cleanEnvironment,
  listen,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";

// Exercise the final provisionHarness environment with actual Git and receive-pack.
// The loopback proxy records request sizes; it does not simulate OCE authorization.
export async function verifyOpenShellPushNegotiation(t, environment) {
  const upstream = await startGitSmartHttpFixture(t);
  const directory = await temporaryDirectory(t, "openshell-push-negotiation-");
  const seed = join(directory, "seed");
  const client = join(directory, "client");
  const base = cleanEnvironment({
    HOME: directory,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  });
  const selected = { ...base, ...environment };
  const git = (cwd, args, env = base, allowFailure = false) =>
    run("git", args, { cwd, env, allowFailure });
  await git(directory, ["clone", upstream.bare, seed]);
  // Incompressible shared history makes redundant ancestry exceed the protected
  // sender's 4 MiB limit even though the new commit itself is tiny.
  await writeFile(join(seed, "history.bin"), randomBytes(5 * 1024 * 1024));
  await git(seed, ["add", "."]);
  await git(seed, ["commit", "-m", "Shared history"]);
  await git(seed, ["push", "origin", "HEAD:refs/heads/main"]);
  await git(directory, ["clone", "--no-local", upstream.bare, client]);
  const parent = (await git(client, ["rev-parse", "HEAD"])).stdout.trim();
  // The remote tip moves after the Agent fetched. The client cannot infer that
  // the remote still has its parent from the receive-pack advertisement alone.
  await writeFile(join(seed, "advanced.txt"), "Remote moved after the client fetched.\n");
  await git(seed, ["add", "."]);
  await git(seed, ["commit", "-m", "Advance remote"]);
  await git(seed, ["push", "origin", "HEAD:refs/heads/main"]);
  const remoteTip = (await git(seed, ["rev-parse", "HEAD"])).stdout.trim();
  assert.notEqual((await git(client, ["cat-file", "-e", remoteTip], base, true)).code, 0);
  await writeFile(join(client, "marker.txt"), "Small Agent change.\n");
  await git(client, ["add", "."]);
  await git(client, ["commit", "-m", "Small change"]);
  const commit = (await git(client, ["rev-parse", "HEAD"])).stdout.trim();
  assert.equal((await git(client, ["rev-parse", "HEAD^"])).stdout.trim(), parent);
  const hook = join(client, ".git/hooks/pre-push");
  await writeFile(hook, '#!/bin/sh\nprintf "invoked\\n" >> .git/hook-runs\n');
  await chmod(hook, 0o700);
  // A repository-level preference remains intact: only the provisioned process
  // receives the default, which Git's explicit -c option can still override.
  await git(client, ["config", "push.negotiate", "false"]);
  const config = await readFile(join(client, ".git/config"));
  const requests = [];
  const proxy = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      requests.push({ path: incoming.url, method: incoming.method, bytes: body.length });
      const headers = { ...incoming.headers, "content-length": String(body.length) };
      delete headers["transfer-encoding"];
      const forwarded = request(
        new URL(incoming.url, upstream.origin),
        {
          method: incoming.method,
          headers,
          ca: upstream.tls.cert,
        },
        (response) => {
          outgoing.writeHead(response.statusCode, response.headers);
          response.pipe(outgoing);
        },
      );
      forwarded.on("error", () => outgoing.destroy());
      forwarded.end(body);
    } catch {
      outgoing.destroy();
    }
  });
  const origin = (await listen(t, proxy)).replace("https:", "http:");
  const url = `${origin}/${upstream.repository}.git`;
  const push = (ref, extra = []) =>
    git(client, [...extra, "push", "--porcelain", url, `HEAD:${ref}`], selected);
  await push("refs/heads/unnegotiated", ["-c", "push.negotiate=false"]);
  const first = requests.filter(
    (entry) => entry.path.endsWith("/git-receive-pack") && entry.bytes > 0,
  );
  assert.ok(
    first.some((entry) => entry.bytes > 4 * 1024 * 1024),
    "the control sends redundant shared history",
  );
  await git(upstream.bare, ["update-ref", "-d", "refs/heads/unnegotiated"]);
  requests.length = 0;
  await push("refs/heads/negotiated");
  const uploads = requests.filter(
    (entry) => entry.path.endsWith("/git-upload-pack") && entry.method === "POST",
  );
  assert.ok(uploads.length > 0, "the final Sandbox environment enables real negotiation");
  const pushes = requests.filter(
    (entry) => entry.path.endsWith("/git-receive-pack") && entry.bytes > 0,
  );
  assert.equal(pushes.length, 1);
  assert.ok(pushes[0].bytes < 4096, "only the small new commit is transferred");
  assert.equal(await upstream.ref("refs/heads/negotiated"), commit);
  assert.equal(await readFile(join(client, ".git/hook-runs"), "utf8"), "invoked\ninvoked\n");
  assert.deepEqual(await readFile(join(client, ".git/config")), config);
}
