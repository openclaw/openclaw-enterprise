import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { request } from "node:https";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import {
  cleanEnvironment,
  listen,
  run as runProcess,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";

const run: (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: ReturnType<typeof cleanEnvironment>; allowFailure?: boolean },
) => ReturnType<typeof runProcess> = runProcess;

export interface RepositorySetHttpRequest {
  target: {
    scheme: string;
    host: string;
    port: number;
    method: string;
    path: string;
    query: string;
  };
  headers: { name: string; value: string }[];
  body: Buffer;
}

/** Controlled supervisor transport only. The caller must invoke the running production
 * middleware and supply credentials captured from its real provider installation. */
export async function exerciseNativeRepositorySet(
  t: TestContext,
  options: {
    repositories: readonly [string, string, string];
    evaluate: (input: RepositorySetHttpRequest) => Promise<{ decision: number }>;
    installed: (repository: string) => string | undefined;
    afterRead?: () => Promise<void>;
    authorize: (authorization: string | undefined, repository: string) => boolean;
  },
) {
  const control = `independent-origin-control-${randomUUID()}`;
  const basic = (value: string) =>
    `Basic ${Buffer.from(`x-access-token:${value}`).toString("base64")}`;
  const origins = await Promise.all(
    options.repositories.map((repository) =>
      startGitSmartHttpFixture(t, {
        repository,
        authorize: (header) => header === basic(control) || options.authorize(header, repository),
      }),
    ),
  );
  const failures: unknown[] = [];
  const callbacks: { path: string; method: string; decision: number }[] = [];
  const peer = createServer((incoming, outgoing) => {
    void (async () => {
      const url = new URL(incoming.url!, "https://github.com");
      const origin = origins.find((entry) => url.pathname.startsWith(`/${entry.repository}.git/`));
      assert.ok(origin, "transport cannot leave the three controlled origins");
      assert.equal(
        incoming.headers.authorization,
        undefined,
        "Git never receives provider material",
      );
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) {
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      assert.ok(body.length <= 4 * 1024 * 1024);
      const hidden = new Set([
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        "authorization",
      ]);
      const headers = Object.entries(incoming.headers).flatMap(([name, value]) =>
        hidden.has(name) || value === undefined
          ? []
          : (Array.isArray(value) ? value : [value]).map((entry) => ({ name, value: entry })),
      );
      const target = {
        scheme: "https",
        host: "github.com",
        port: 443,
        method: incoming.method!,
        path: url.pathname,
        query: url.search.slice(1),
      };
      const result = await options.evaluate({ target, headers, body });
      callbacks.push({ path: target.path, method: target.method, decision: result.decision });
      if (result.decision !== 1) {
        outgoing.writeHead(403).end();
        return;
      }
      const installed = options.installed(origin.repository);
      assert.ok(installed, "allowed request needs material installed by the production owner");
      await new Promise<void>((resolve, reject) => {
        const upstream = request(
          origin.origin,
          {
            // Fix the network destination to the test-owned origin; request input is only a path.
            path: url.pathname + url.search,
            method: incoming.method,
            ca: origin.tls.ca,
            headers: {
              ...Object.fromEntries(headers.map(({ name, value }) => [name, value])),
              authorization: basic(installed),
              "content-length": String(body.length),
            },
          },
          (response) => {
            outgoing.writeHead(response.statusCode!, response.headers);
            response.pipe(outgoing);
            response.once("end", resolve);
            response.once("error", reject);
          },
        );
        upstream.once("error", reject);
        upstream.end(body);
      });
    })().catch((error: unknown) => {
      failures.push(error);
      outgoing.writeHead(502).end();
    });
  });
  const peerUrl = (await listen(t, peer)).replace("https:", "http:");
  const root = await temporaryDirectory(t, "native-repository-set-");
  const env = cleanEnvironment({ HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" });
  const canonical = (repository: string) => `https://github.com/${repository}.git`;
  const git = async (args: string[], cwd = root, allowedFailure = false) => {
    const result = await run(
      "git",
      [
        "-c",
        `url.${peerUrl}/.insteadOf=https://github.com/`,
        "-c",
        "credential.helper=",
        "-c",
        "http.followRedirects=false",
        ...args,
      ],
      { cwd, env, allowFailure: true },
    );
    if (!allowedFailure) {
      assert.equal(result.code, 0, `native Git ${args[0]} failed: ${result.stderr}`);
    }
    return result;
  };
  const readRefs = async (index: number) =>
    (
      await run("git", ["for-each-ref", "--format=%(refname) %(objectname)"], {
        cwd: origins[index]!.bare,
        env,
      })
    ).stdout;
  const cBefore = await readRefs(2);
  const branch = `refs/heads/native-${randomUUID()}`;
  const commits: string[][] = [[], []];
  for (const index of [0, 1]) {
    const path = join(root, String(index));
    await git(["clone", canonical(options.repositories[index]!), path]);
    await git(["config", "user.name", "Repository acceptance"], path);
    await git(["config", "user.email", "acceptance@example.test"], path);
  }
  await options.afterRead?.();
  // Interleave pushes: opening B must not replace A's binding on the same Agent.
  for (const step of [1, 2]) {
    for (const index of [0, 1]) {
      const path = join(root, String(index));
      await writeFile(join(path, "acceptance.txt"), `Repository ${index}, commit ${step}\n`);
      await git(["add", "acceptance.txt"], path);
      await git(["commit", "-m", `Acceptance ${step}`], path);
      const sha = (await git(["rev-parse", "HEAD"], path)).stdout.trim();
      await git(["push", "origin", `HEAD:${branch}`], path);
      assert.equal(await origins[index]!.ref(branch), sha, "independent remote ref readback");
      commits[index]!.push(sha);
    }
  }
  const cAccepted = origins[2]!.trace.length;
  const denied = await git(
    ["push", canonical(options.repositories[2]), `HEAD:${branch}`],
    join(root, "0"),
    true,
  );
  assert.notEqual(denied.code, 0, "unselected C must refuse ordinary Git push");
  assert.equal(await readRefs(2), cBefore, "C denial leaves every remote ref unchanged");
  assert.equal(
    origins[2]!.trace.length,
    cAccepted,
    "C receives no authenticated Git backend request",
  );
  for (const index of [0, 1]) {
    assert.notEqual(commits[index]![0], commits[index]![1]);
    assert.equal(
      (
        await run("git", ["rev-parse", `${branch}^`], { cwd: origins[index]!.bare, env })
      ).stdout.trim(),
      commits[index]![0],
    );
    assert.equal(
      callbacks.filter(
        (entry) =>
          entry.path === `/${options.repositories[index]}.git/git-receive-pack` &&
          entry.method === "POST" &&
          entry.decision === 1,
      ).length,
      2,
    );
  }
  assert.ok(
    callbacks.some(
      (entry) => entry.path.startsWith(`/${options.repositories[2]}.git/`) && entry.decision === 2,
    ),
    "the Agent's C request is denied by the middleware",
  );
  const anotherRef = `${branch}-another`;
  await git(["push", "origin", `HEAD:${anotherRef}`], join(root, "0"));
  assert.equal(
    await origins[0]!.ref(anotherRef),
    commits[0]![1],
    "another permitted ref in A remains writable",
  );
  // Independently check the provider boundary with the exact credential used for A/B.
  // This bypasses the middleware only as a negative control; it must not grant C access.
  const selectedMaterial = options.installed(options.repositories[0]);
  assert.ok(selectedMaterial);
  const providerDenied = await run(
    "git",
    [
      "-c",
      `http.sslCAInfo=${origins[2]!.tls.certFile}`,
      "-c",
      `http.extraHeader=Authorization: ${basic(selectedMaterial)}`,
      "push",
      `${origins[2]!.origin}/${options.repositories[2]}.git`,
      `HEAD:${branch}`,
    ],
    { cwd: join(root, "0"), env, allowFailure: true },
  );
  assert.notEqual(providerDenied.code, 0, "the issued A/B token cannot write C at the provider");
  assert.deepEqual(await readRefs(2), cBefore);
  assert.equal(origins[2]!.trace.length, cAccepted);
  // Independent origin control, outside the Agent: C is reachable and write-enabled.
  await run(
    "git",
    [
      "-c",
      `http.sslCAInfo=${origins[2]!.tls.certFile}`,
      "-c",
      `http.extraHeader=Authorization: ${basic(control)}`,
      "push",
      `${origins[2]!.origin}/${options.repositories[2]}.git`,
      `HEAD:${branch}`,
    ],
    { cwd: join(root, "0"), env },
  );
  assert.equal(await origins[2]!.ref(branch), commits[0]![1]);
  assert.deepEqual(failures, []);
  t.diagnostic(
    `Native A/B pushes: ${JSON.stringify(commits)}; C denied unchanged; independent C control passed.`,
  );
}
