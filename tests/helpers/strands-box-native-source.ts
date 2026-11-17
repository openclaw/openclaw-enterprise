import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { SOURCE_BEARER_ENV } from "../../deploy/examples/strands-box/host/credential-source.ts";
import { policy } from "../../deploy/examples/strands-box/host/egress.ts";
import { activateStageB, pairedFixture } from "./strands-box-protected-fixture.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const execute = promisify(execFile);

// Stage B against a real Box build with the request-time credential source (the Box fork's
// dogfood/main): `strands-box run` reads the host's own credential tables and GitHub policy,
// asks the host's real credential source for every GitHub request, and the paired Driver
// answers each ask with OCE's decision from requests.authorize (#6350). Stock git and gh run
// inside Box against the controlled GitHub origin on 127.0.0.1:443, which github.com and
// api.github.com resolve to on this host. Manual lane strands-box-native only.

// Runs inside Box as the workload: executes each queued argv directly (no shell) and writes
// its result. Box gives it exactly the workload environment, which it reports once.
export const RUNNER = `import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const queue = process.argv[2];
writeFileSync(join(queue, "ready.tmp"), JSON.stringify({ pid: process.pid, env: process.env }));
renameSync(join(queue, "ready.tmp"), join(queue, "ready"));
while (!existsSync(join(queue, "stop"))) {
  for (const name of readdirSync(queue).filter((n) => n.endsWith(".cmd")).sort()) {
    const base = join(queue, name.slice(0, -4));
    const { argv, cwd } = JSON.parse(readFileSync(join(queue, name), "utf8"));
    renameSync(join(queue, name), base + ".run");
    const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", timeout: 40000 });
    writeFileSync(base + ".tmp", JSON.stringify({ code: r.status, signal: r.signal, error: r.error ? String(r.error.message) : undefined, stdout: r.stdout, stderr: r.stderr }));
    renameSync(base + ".tmp", base + ".out");
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
`;

export interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export async function until<T>(
  what: string,
  deadline: number,
  probe: () => Promise<T | undefined>,
) {
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function stageBRealBox(
  t: TestContext,
  inputs: { readonly boxBin: string; readonly gh: string },
) {
  // Preconditions of the controlled origin: GitHub's names resolve here, port 443 is bindable.
  for (const name of ["github.com", "api.github.com"]) {
    assert.equal((await lookup(name, { family: 4 })).address, "127.0.0.1", `${name} -> 127.0.0.1`);
  }
  for (const helper of ["strands-box-sock-alias", "strands-box-contain-trampoline"]) {
    assert.ok((await stat(join(dirname(inputs.boxBin), helper))).isFile(), `${helper} beside Box`);
  }
  const version = (await execute(inputs.boxBin, ["--version"], { timeout: 10_000 })).stdout.trim();
  t.diagnostic(`box: ${version}`);
  const gitVersion = (await execute("/usr/bin/git", ["--version"])).stdout.trim();
  const ghVersion = (
    await execute(inputs.gh, ["--version"], { env: { HOME: "/nonexistent" } })
  ).stdout.split("\n")[0]!;
  t.diagnostic(`${gitVersion}; ${ghVersion}`);

  const f = await pairedFixture(t, { originPort: 443 });
  const signal = AbortSignal.timeout(300_000);
  const { binding, settledAt } = await activateStageB(f, signal);
  // Stop `box run` and the Driver's source loop before the fixture's own cleanup, pass or fail.
  let stopBox = async () => {};
  try {
    return await withBinding();
  } finally {
    await stopBox();
    await binding.close();
  }

  async function withBinding() {
    // Box's own files: a fresh box_dir, the policy and box.toml in a directory no grant covers.
    const root = await temporaryDirectory(t, "stage-b-box-");
    const authority = join(root, "authority");
    const agent = join(root, "agent");
    const queue = join(root, "queue");
    const home = join(root, "home");
    for (const directory of [authority, agent, queue, home, join(home, "gh")]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    await writeFile(join(agent, "runner.mjs"), RUNNER, { mode: 0o600 });
    const policyFile = join(authority, "policy.dw");
    await writeFile(policyFile, policy([], true), { mode: 0o600 });
    const quoted = (value: string) => JSON.stringify(value);
    const node = process.execPath;
    const env = {
      HOME: home,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GH_CONFIG_DIR: join(home, "gh"),
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
    };
    // Node's prefix unless it is a system root (Box refuses /usr/local as a tree); git's helpers
    // and libcurl where this distribution keeps them (Fedora or Debian/Ubuntu multiarch).
    const prefix = dirname(dirname(node));
    const read = [
      ...(["/usr", "/usr/local", "/"].includes(prefix) ? [] : [prefix]),
      agent,
      queue,
      f.workspace,
      home,
      ...[
        "/usr/share/git-core",
        "/usr/lib64",
        `/usr/lib/${process.arch === "x64" ? "x86_64" : "aarch64"}-linux-gnu`,
      ].filter((path) => existsSync(path)),
    ];
    const write = [queue, f.workspace, home];
    const gitCore = ["/usr/libexec/git-core", "/usr/lib/git-core"].filter((path) =>
      existsSync(path),
    );
    const exec = [node, "/usr/bin/git", ...gitCore, inputs.gh];
    const boxFile = join(authority, "box.toml");
    await writeFile(
      boxFile,
      [
        'name = "oce-stage-b"',
        `box_dir = ${quoted(join(root, "box-state"))}`,
        `policy = ${quoted(policyFile)}`,
        "",
        // The controlled origin's CA: a test stand-in for GitHub's public roots, never a deployment
        // setting. The host writes the same key for its controlled model route.
        "[gateway]",
        `upstream_ca_file = ${quoted(f.origin.rootCertificatePath)}`,
        "",
        "[agent]",
        `command = [${[node, "--jitless", join(agent, "runner.mjs"), queue].map(quoted).join(", ")}]`,
        `workspace = ${quoted(f.workspace)}`,
        "",
        "[agent.env]",
        ...Object.entries(env).map(([key, value]) => `${key} = ${quoted(value)}`),
        "",
        "[agent.filesystem]",
        `read = [${read.map(quoted).join(", ")}]`,
        `write = [${write.map(quoted).join(", ")}]`,
        `exec = [${exec.map(quoted).join(", ")}]`,
        "",
        // Exactly the host's credential tables for this execution's source.
        f.boxConfig,
      ].join("\n"),
      { mode: 0o600 },
    );
    // `box run` holds the source bearer in its environment only; nothing else of OCE's.
    const child = spawn(inputs.boxBin, ["run", "--config", boxFile], {
      cwd: f.workspace,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: process.env.HOME ?? home,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        EXPERIMENTAL_LINUX_SUPPORT: "TRUE",
        ...(process.arch === "x64" ? { EXPERIMENTAL_X86_SUPPORT: "TRUE" } : {}),
        [SOURCE_BEARER_ENV]: f.bearer,
      },
    });
    let boxOutput = "";
    child.stdout.on("data", (chunk: Buffer) => (boxOutput = (boxOutput + chunk).slice(-16_384)));
    child.stderr.on("data", (chunk: Buffer) => (boxOutput = (boxOutput + chunk).slice(-16_384)));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    stopBox = async () => {
      if (child.exitCode === null && child.signalCode === null) {
        await writeFile(join(queue, "stop"), "");
        const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
        await exited;
        clearTimeout(timer);
      }
    };
    const failWith = (what: string) => new Error(`${what}\n--- box output ---\n${boxOutput}`);
    const ready = await until("the Box workload", Date.now() + 90_000, async () => {
      if (child.exitCode !== null) {
        throw failWith(`box run exited ${child.exitCode}`);
      }
      return existsSync(join(queue, "ready"))
        ? (JSON.parse(await readFile(join(queue, "ready"), "utf8")) as {
            pid: number;
            env: Record<string, string>;
          })
        : undefined;
    });
    const boxPid = child.pid;
    let sequence = 0;
    const run = async (argv: readonly string[]): Promise<Result> => {
      const base = join(queue, String(++sequence).padStart(4, "0"));
      await writeFile(`${base}.tmp`, JSON.stringify({ argv, cwd: f.workspace }));
      await rename(`${base}.tmp`, `${base}.cmd`);
      return until(`command ${argv.join(" ")}`, Date.now() + 60_000, async () => {
        if (child.exitCode !== null) {
          throw failWith(`box run exited ${child.exitCode}`);
        }
        return existsSync(`${base}.out`)
          ? (JSON.parse(await readFile(`${base}.out`, "utf8")) as Result)
          : undefined;
      });
    };
    const ok = async (argv: readonly string[]) => {
      const result = await run(argv);
      assert.equal(result.code, 0, `${argv.join(" ")}: ${result.stderr}${result.error ?? ""}`);
      return result;
    };
    const git = (args: readonly string[]) => ["/usr/bin/git", ...args];
    const gh = (args: readonly string[]) => [inputs.gh, ...args];

    // The workload sees only Box's placeholders, proxy and CA: no token, no source bearer, and no
    // credential helper, askpass or insteadOf: stock clients only.
    const workload = ready.env;
    for (const value of Object.values(workload)) {
      assert.ok(!value.includes(f.origin.credential));
      assert.ok(!value.includes(f.bearer));
    }
    assert.ok(workload.GITHUB_TOKEN && workload.OCE_GITHUB_GIT_CREDENTIAL);
    assert.ok(workload.HTTPS_PROXY ?? workload.https_proxy);
    assert.equal(workload[SOURCE_BEARER_ENV], undefined);
    for (const name of Object.keys(workload)) {
      assert.doesNotMatch(name, /ASKPASS|CREDENTIAL_HELPER/);
    }
    const config = await run(git(["config", "--list", "--show-origin"]));
    assert.doesNotMatch(config.stdout, /credential\.|insteadof|url\./i);

    // Stock git: clone, commit, push. Every request Box sends is asked once and decided once.
    const remote = `https://github.com/${f.origin.repository.repository}.git`;
    await ok(git(["clone", remote, "."]));
    await ok(git(["switch", "-c", "review"]));
    await writeFile(join(f.workspace, "tracked.txt"), "review change\n");
    await ok(
      git([
        "-c",
        "user.name=Agent",
        "-c",
        "user.email=agent@example.invalid",
        "commit",
        "-am",
        "review change",
      ]),
    );
    const head = (await ok(git(["rev-parse", "HEAD"]))).stdout.trim();
    await ok(git(["push", remote, "review"]));
    assert.equal(
      (
        await f.origin.git(["--git-dir", f.origin.repoPath, "rev-parse", "refs/heads/review"])
      ).stdout.trim(),
      head,
    );
    const gitAsks = f.host.answered.length;
    assert.ok(gitAsks >= 4, "clone and push take several smart-HTTP requests");
    assert.ok(f.host.answered.every((outcome) => outcome === "credential"));
    assert.equal(f.state.uses.length, gitAsks, "one OCE decision per Box ask");
    assert.equal(new Set(f.state.uses.map(({ exchangeId }) => exchangeId)).size, gitAsks);
    assert.equal(
      f.origin.writes.length,
      gitAsks,
      "each released value carried exactly one request",
    );
    assert.deepEqual([...new Set(f.state.uses.map(({ operation }) => operation))].sort(), [
      "advertise-receive-pack",
      "advertise-upload-pack",
      "receive-pack",
      "upload-pack",
    ]);

    // Stock gh: one draft through GraphQL, each request decided by OCE.
    const created = await ok(
      gh([
        "pr",
        "create",
        "--draft",
        "--repo",
        f.origin.repository.repository,
        "--head",
        "review",
        "--base",
        "main",
        "--title",
        "Review change",
        "--body",
        "From the Box workload",
      ]),
    );
    assert.match(created.stdout, /https:\/\/github\.com\/example\/review\/pull\/7/);
    assert.equal(f.origin.pulls.length, 1);
    assert.equal(f.origin.pulls[0]!.draft, true);
    assert.ok(f.state.uses.length > gitAsks);
    assert.ok(f.state.uses.every(({ allowed }) => allowed));
    assert.equal(f.state.uses.length, f.host.answered.length);
    const ghOperations = [
      ...new Set(f.state.uses.slice(gitAsks).map(({ operation }) => operation)),
    ];

    // Renewal: the same `box run` keeps running; until the Worker confirms the new version OCE
    // refuses, then the next request gets the renewed token.
    f.renew();
    const renewed = await run(git(["ls-remote", remote, "HEAD"]));
    assert.notEqual(renewed.code, 0);
    assert.equal(f.host.answered.at(-1), "route_not_ready");
    await binding.reconcile!(signal);
    assert.equal(f.state.installs, 2);
    assert.equal(f.state.confirms, 2);
    assert.equal(f.sandbox.repositoryAccess!.materialSettledAt(f.revision.id), settledAt);
    assert.match((await ok(git(["ls-remote", remote, "HEAD"]))).stdout, /\tHEAD$/m);
    assert.equal(child.pid, boxPid);
    assert.equal(child.exitCode, null);
    assert.equal(f.host.deletes, 0);

    // The wrong repository: OCE refuses; no request byte reaches the provider.
    const provider = () => ({ writes: f.origin.writes.length, refusals: f.origin.refusals.length });
    const before = provider();
    const connectionsBefore = f.origin.connections();
    const other = await run(git(["push", "https://github.com/example/other.git", "review"]));
    assert.notEqual(other.code, 0);
    assert.equal(f.host.answered.at(-1), "request_not_allowed");
    const otherApi = await run(gh(["api", "repos/example/other", "--jq", ".full_name"]));
    assert.notEqual(otherApi.code, 0);
    assert.equal(f.host.answered.at(-1), "request_not_allowed");
    assert.deepEqual(provider(), before);
    const refusedConnections = f.origin.connections() - connectionsBefore;

    // A host outside Box's policy: Box refuses it and OCE is never asked.
    const asked = f.host.answered.length;
    const outside = await run(git(["ls-remote", "https://gitlab.com/example/review.git"]));
    assert.notEqual(outside.code, 0);
    assert.equal(f.host.answered.length, asked);

    // Withdrawal: OCE refuses the very next request before any provider byte; `box run` and the
    // workload keep running, and nothing is sent to the host.
    assert.equal(
      await f.sandbox.repositoryAccess!.retireExpired({ revision: f.revision, signal } as never),
      "withdrawn",
    );
    f.state.withdrawn = true;
    const withdrawnAt = provider();
    const again = await run(git(["push", remote, "review:refs/heads/again"]));
    assert.notEqual(again.code, 0);
    assert.equal(f.host.answered.at(-1), "access_withdrawn");
    const draftAgain = await run(
      gh([
        "pr",
        "create",
        "--draft",
        "--repo",
        f.origin.repository.repository,
        "--head",
        "review",
        "--base",
        "main",
        "--title",
        "Again",
        "--body",
        "x",
      ]),
    );
    assert.notEqual(draftAgain.code, 0);
    assert.equal(f.host.answered.at(-1), "access_withdrawn");
    assert.deepEqual(provider(), withdrawnAt);
    assert.equal(f.origin.pulls.length, 1);
    await binding.reconcile!(signal);
    assert.equal(f.host.deletes, 0);
    assert.equal(child.pid, boxPid);
    assert.equal(child.exitCode, null);
    await ok(git(["--version"]));

    await writeFile(join(queue, "stop"), "");
    const code = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 20_000)),
    ]);
    return {
      version,
      gitVersion,
      ghVersion,
      gitAsks,
      decisions: f.state.uses.length,
      ghOperations,
      refusedConnections,
      answered: [...f.host.answered],
      renewedMessage: renewed.stderr.slice(-300),
      withdrawnMessage: again.stderr.slice(-300),
      outsideMessage: outside.stderr.slice(-300),
      exit: code,
    };
  }
}
