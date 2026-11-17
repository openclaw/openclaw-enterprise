import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { SOURCE_BEARER_ENV } from "../../deploy/examples/strands-box/host/credential-source.ts";
import { policy } from "../../deploy/examples/strands-box/host/egress.ts";
import { certificateAuthority, signedLeaf } from "./certificates.ts";
import { fakeKubernetesSecrets, testModelKey } from "./strands-box-model-fixture.ts";
import { type Result, until } from "./strands-box-native-source.ts";
import {
  activateStageB,
  id,
  MODEL_SOURCE_ID,
  namespace,
  pairedFixture,
} from "./strands-box-protected-fixture.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const execute = promisify(execFile);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

// The protected model route against a real Box build (the Box fork's request-time credential
// source): `strands-box run` gets the host's two source tables (GitHub and the model route), the
// model route's policy and the GitHub policy. A workload in Box calls the model fixture with the
// placeholder in OPENAI_API_KEY; Box asks the host's model source, the paired Driver answers from
// the package's Secret (a stand-in Kubernetes API), and Box sends the key upstream. The fixture
// model endpoint is an operator name pinned to a private address on this host. Manual lane
// strands-box-native only; the test key is generated here and never printed.

/** In-Box runner: like the Stage B runner, plus an optional stdin taken from one variable. */
const RUNNER = `import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const queue = process.argv[2];
writeFileSync(join(queue, "ready.tmp"), JSON.stringify({ pid: process.pid, env: process.env }));
renameSync(join(queue, "ready.tmp"), join(queue, "ready"));
while (!existsSync(join(queue, "stop"))) {
  for (const name of readdirSync(queue).filter((n) => n.endsWith(".cmd")).sort()) {
    const base = join(queue, name.slice(0, -4));
    const { argv, cwd, stdinEnv } = JSON.parse(readFileSync(join(queue, name), "utf8"));
    renameSync(join(queue, name), base + ".run");
    const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", timeout: 60000, maxBuffer: 1 << 20, ...(stdinEnv ? { input: process.env[stdinEnv] ?? "" } : {}) });
    writeFileSync(base + ".tmp", JSON.stringify({ code: r.status, signal: r.signal, error: r.error ? String(r.error.message) : undefined, stdout: r.stdout, stderr: r.stderr }));
    renameSync(base + ".tmp", base + ".out");
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
`;

/**
 * In-Box model client: one request with the workload's placeholder as the bearer, through Box's
 * proxy (Node's env proxy opt-in and CA, as Box sets them). Prints the status, the response's
 * size, digest, chunk count and timing, and the request body's digest; never a header value.
 */
const CLIENT = `const [url, method, size] = process.argv.slice(2);
const n = Number(size);
const prefix = '{"model":"fixture-model","stream":true,"input":"';
const body = n > 0 ? Buffer.concat([Buffer.from(prefix), Buffer.alloc(Math.max(0, n - prefix.length - 2), 0x61), Buffer.from('"}')]) : undefined;
const started = Date.now();
const out = { bodyBytes: body?.length ?? 0, bodySha256: body ? (await import("node:crypto")).createHash("sha256").update(body).digest("hex") : undefined };
try {
  const response = await fetch(url, { method, body, headers: { authorization: "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json", accept: "text/event-stream" } });
  out.status = response.status;
  const hash = (await import("node:crypto")).createHash("sha256");
  let bytes = 0, chunks = 0, first;
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of response.body) {
    if (first === undefined) first = Date.now() - started;
    chunks++; bytes += chunk.length; hash.update(chunk);
    if (text.length < 4096) text += decoder.decode(chunk, { stream: true });
  }
  Object.assign(out, { bytes, chunks, firstChunkMs: first, totalMs: Date.now() - started, sha256: hash.digest("hex"), events: (text.match(/^data: /gm) ?? []).length, head: text.slice(0, 200) });
} catch (error) {
  out.error = String(error?.cause?.code ?? error?.code ?? error?.message ?? error).slice(0, 200);
}
process.stdout.write(JSON.stringify(out));
`;

interface ClientResult {
  readonly status?: number;
  readonly bytes?: number;
  readonly chunks?: number;
  readonly firstChunkMs?: number;
  readonly totalMs?: number;
  readonly sha256?: string;
  readonly events?: number;
  readonly bodyBytes: number;
  readonly bodySha256?: string;
  readonly error?: string;
}

/** SSE events the fixture streams per response, and the gap between them. */
const EVENTS = 5;
const EVENT_GAP_MS = 400;

export interface NativeModelInputs {
  readonly boxBin: string;
  /** Stock Codex, for `codex login --with-api-key` inside Box (auth.json holds the placeholder). */
  readonly codexBin?: string;
  /** The operator name of the fixture model endpoint and its pinned private IPv4 on this host. */
  readonly modelHost: string;
  readonly modelAddress: string;
  readonly modelPort: number;
}

export async function modelRealBox(t: TestContext, inputs: NativeModelInputs) {
  for (const name of ["github.com", "api.github.com"]) {
    assert.equal((await lookup(name, { family: 4 })).address, "127.0.0.1", `${name} -> 127.0.0.1`);
  }
  assert.equal(
    (await lookup(inputs.modelHost, { family: 4 })).address,
    inputs.modelAddress,
    `${inputs.modelHost} -> ${inputs.modelAddress}`,
  );
  for (const helper of ["strands-box-sock-alias", "strands-box-contain-trampoline"]) {
    assert.ok((await stat(join(dirname(inputs.boxBin), helper))).isFile(), `${helper} beside Box`);
  }
  const version = (await execute(inputs.boxBin, ["--version"], { timeout: 10_000 })).stdout.trim();
  t.diagnostic(`box: ${version}`);

  const route = `https://${inputs.modelHost}:${inputs.modelPort}/v1`;
  const kube = await fakeKubernetesSecrets(t);
  const f = await pairedFixture(t, {
    originPort: 443,
    model: { gateway: kube.configuration, route, address: inputs.modelAddress },
  });
  const gateway = f.gateway!;
  const signal = AbortSignal.timeout(300_000);
  const { binding } = await activateStageB(f, signal);

  // The fixture model endpoint: records what reached it (counts and digests, never a value).
  const tlsDirectory = await temporaryDirectory(t, "model-fixture-tls-");
  const ca = await certificateAuthority(tlsDirectory, { caName: "Model fixture CA", days: 1 });
  const leaf = await signedLeaf(tlsDirectory, ca, {
    name: "model",
    commonName: "Model fixture",
    subjectAltName: `DNS:${inputs.modelHost}`,
    days: 1,
  });
  const provider = {
    connections: 0,
    requests: [] as { method: string; path: string; authSha256: string; bodyBytes: number; bodySha256: string }[],
  };
  const model = createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      provider.requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        authSha256: sha(String(req.headers.authorization ?? "").replace(/^Bearer /, "")),
        bodyBytes: body.length,
        bodySha256: sha(body),
      });
      body.fill(0);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let sent = 0;
      const tick = () => {
        res.write(`data: {"type":"response.output_text.delta","sequence":${sent}}\n\n`);
        if (++sent === EVENTS) {
          res.end("data: [DONE]\n\n");
          return;
        }
        setTimeout(tick, EVENT_GAP_MS);
      };
      tick();
    });
  });
  model.on("secureConnection", () => provider.connections++);
  model.listen(inputs.modelPort, inputs.modelAddress);
  await new Promise((resolve) => model.once("listening", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        model.closeAllConnections();
        model.close(() => resolve());
      }),
  );

  // The model source, registered through the package's Gateway (S1: its own Secret).
  let key = testModelKey();
  const keys = [key];
  const sourceContext = {
    namespace,
    source: {
      id: MODEL_SOURCE_ID,
      namespaceId: namespace.id,
      type: "openai",
      driverId: id,
      config: { authorized_base_url: route },
    } as never,
    signal,
  };
  await gateway.registerSource(sourceContext, {
    type: "openai",
    config: { authorized_base_url: route },
    secrets: { api_key: key },
  });
  const revisionContext = { namespace, revision: f.revision, sources: [sourceContext.source], signal };
  assert.equal((await gateway.attachForRevision(revisionContext)).length, 1);

  let stopBox = async () => {};
  try {
    return await withBox();
  } finally {
    await stopBox();
    await binding.close();
  }

  async function withBox() {
    const root = await temporaryDirectory(t, "model-box-");
    const authority = join(root, "authority");
    const agent = join(root, "agent");
    const queue = join(root, "queue");
    const home = join(root, "home");
    const codexHome = join(home, ".codex");
    for (const directory of [authority, agent, queue, home, codexHome]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    await writeFile(join(agent, "runner.mjs"), RUNNER, { mode: 0o600 });
    await writeFile(join(agent, "client.mjs"), CLIENT, { mode: 0o600 });
    // One upstream CA bundle: the controlled GitHub origin's CA and the model fixture's CA.
    const bundle = join(authority, "upstream-ca.pem");
    await writeFile(
      bundle,
      (await readFile(f.origin.rootCertificatePath, "utf8")) + (await readFile(ca.caPath, "utf8")),
      { mode: 0o600 },
    );
    const policyFile = join(authority, "policy.dw");
    const modelRoute = { kind: "controlled-inference" as const, url: route, address: inputs.modelAddress };
    await writeFile(policyFile, policy([modelRoute], true), { mode: 0o600 });
    const quoted = (value: string) => JSON.stringify(value);
    const node = process.execPath;
    const env = {
      HOME: home,
      CODEX_HOME: codexHome,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      NO_COLOR: "1",
    };
    const codex = inputs.codexBin;
    const read = [dirname(dirname(node)), agent, queue, f.workspace, home, "/usr/share/git-core", "/usr/lib64"];
    if (codex !== undefined) read.push(dirname(codex));
    const write = [queue, f.workspace, home];
    const exec = [node, "/usr/bin/git", "/usr/libexec/git-core", ...(codex === undefined ? [] : [codex])];
    const boxFile = join(authority, "box.toml");
    await writeFile(
      boxFile,
      [
        'name = "oce-model"',
        `box_dir = ${quoted(join(root, "box-state"))}`,
        `policy = ${quoted(policyFile)}`,
        "",
        "[gateway]",
        `upstream_ca_file = ${quoted(bundle)}`,
        "",
        "[agent]",
        `command = [${[node, "--jitless", join(agent, "runner.mjs"), queue].map(quoted).join(", ")}]`,
        `workspace = ${quoted(f.workspace)}`,
        "",
        "[agent.env]",
        ...Object.entries(env).map(([name, value]) => `${name} = ${quoted(value)}`),
        "",
        "[agent.filesystem]",
        `read = [${read.map(quoted).join(", ")}]`,
        `write = [${write.map(quoted).join(", ")}]`,
        `exec = [${exec.map(quoted).join(", ")}]`,
        "",
        // Exactly the host's two credential sources for this execution.
        f.boxConfig,
        f.modelBoxConfig(inputs.modelAddress),
      ].join("\n"),
      { mode: 0o600 },
    );
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
    const failWith = (what: string) => {
      // Box's output never holds the key (asserted below); still, show it only digest-checked.
      for (const value of keys) assert.ok(!boxOutput.includes(value));
      return new Error(`${what}\n--- box output ---\n${boxOutput}`);
    };
    const ready = await until("the Box workload", Date.now() + 90_000, async () => {
      if (child.exitCode !== null) throw failWith(`box run exited ${child.exitCode}`);
      return existsSync(join(queue, "ready"))
        ? (JSON.parse(await readFile(join(queue, "ready"), "utf8")) as { env: Record<string, string> })
        : undefined;
    });
    const boxPid = child.pid;
    let sequence = 0;
    const run = async (argv: readonly string[], stdinEnv?: string): Promise<Result> => {
      const base = join(queue, String(++sequence).padStart(4, "0"));
      await writeFile(`${base}.tmp`, JSON.stringify({ argv, cwd: f.workspace, stdinEnv }));
      await rename(`${base}.tmp`, `${base}.cmd`);
      return until(`command ${argv[0]}`, Date.now() + 90_000, async () => {
        if (child.exitCode !== null) throw failWith(`box run exited ${child.exitCode}`);
        return existsSync(`${base}.out`)
          ? (JSON.parse(await readFile(`${base}.out`, "utf8")) as Result)
          : undefined;
      });
    };
    const call = async (url: string, method = "POST", size = 64): Promise<ClientResult> => {
      const result = await run([node, join(agent, "client.mjs"), url, method, String(size)]);
      assert.equal(result.code, 0, `${result.stderr}${result.error ?? ""}`);
      return JSON.parse(result.stdout) as ClientResult;
    };
    const git = (args: readonly string[]) => run(["/usr/bin/git", ...args]);
    const remote = `https://github.com/${f.origin.repository.repository}.git`;
    const counts = () => ({ ...f.source.modelCounts });
    const evidence: Record<string, unknown> = { box: version, route };

    // The workload holds only Box's placeholder: the key is in no variable.
    const workload = ready.env;
    const placeholder = workload.OPENAI_API_KEY;
    assert.ok(placeholder, "Box sets the model placeholder");
    assert.notEqual(placeholder, key);
    const envText = JSON.stringify(workload);
    evidence.keySha256 = sha(key);
    evidence.envKeyMatches = envText.split(key).length - 1;
    evidence.envBearerMatches = envText.split(f.bearer).length - 1;
    assert.equal(evidence.envKeyMatches, 0);
    assert.equal(evidence.envBearerMatches, 0);
    assert.equal(workload[SOURCE_BEARER_ENV], undefined);
    evidence.placeholderShape = placeholder.replace(/[0-9a-f]{16,}/, "<hex>");

    // Stock Codex logs in with the variable: its auth.json holds the placeholder only.
    if (codex !== undefined) {
      const login = await run([codex, "login", "--with-api-key"], "OPENAI_API_KEY");
      assert.equal(login.code, 0, `codex login: ${login.stderr.slice(-400)}`);
      const authFiles = (await readdir(codexHome)).filter((name) => name === "auth.json");
      assert.deepEqual(authFiles, ["auth.json"]);
      const auth = await readFile(join(codexHome, "auth.json"), "utf8");
      evidence.authJsonKeyMatches = auth.split(key).length - 1;
      evidence.authJsonPlaceholderMatches = auth.split(placeholder).length - 1;
      assert.equal(evidence.authJsonKeyMatches, 0);
      assert.ok(Number(evidence.authJsonPlaceholderMatches) >= 1);
    } else {
      evidence.authJson = "not run (no codex binary given)";
    }

    // 1. Allowed: the fixture receives the test key; the SSE stream arrives as it is sent.
    const allowed = await call(`${route}/responses`);
    assert.equal(allowed.status, 200, JSON.stringify(allowed));
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0]!.authSha256, sha(key));
    assert.equal(provider.requests[0]!.bodySha256, allowed.bodySha256);
    assert.equal(allowed.events, EVENTS + 1);
    assert.ok(allowed.chunks! >= 2, "streamed in more than one chunk");
    assert.ok(
      allowed.firstChunkMs! < allowed.totalMs! - (EVENTS - 2) * EVENT_GAP_MS,
      "the first event arrives long before the last: not buffered",
    );
    evidence.allowed = allowed;
    assert.equal(f.host.answered.at(-1), "credential");

    // 2. Wrong path, method or host: Box refuses before any OCE ask and before the provider.
    const asked = counts().asked;
    const reached = provider.requests.length;
    const connected = provider.connections;
    const refusedCalls: Record<string, ClientResult> = {};
    for (const [label, url, method] of [
      ["path", `${route}/chat/completions`, "POST"],
      ["sub-path", `${route}/responses/compact`, "POST"],
      ["method", `${route}/responses`, "GET"],
      ["host-ip-literal", `https://${inputs.modelAddress}:${inputs.modelPort}/v1/responses`, "POST"],
      ["host-other-port", `https://${inputs.modelHost}:${inputs.modelPort + 1}/v1/responses`, "POST"],
    ] as const) {
      const result = await call(url, method, method === "GET" ? 0 : 64);
      refusedCalls[label] = result;
      assert.notEqual(result.status, 200, `${label}: ${JSON.stringify(result)}`);
    }
    assert.equal(counts().asked, asked, "OCE was never asked");
    assert.equal(provider.requests.length, reached, "no request reached the provider");
    evidence.refused = refusedCalls;
    evidence.refusedProviderConnections = provider.connections - connected;

    // 3. Rotation: the next request carries the new key; Box keeps running.
    key = testModelKey();
    keys.push(key);
    await gateway.updateSource(sourceContext, {
      type: "openai",
      config: { authorized_base_url: route },
      secrets: { api_key: key },
    });
    const rotated = await call(`${route}/responses`);
    assert.equal(rotated.status, 200);
    assert.equal(provider.requests.at(-1)!.authSha256, sha(key));
    assert.equal(child.pid, boxPid);
    assert.equal(child.exitCode, null);
    evidence.rotatedKeySha256 = sha(key);

    // 4. A body near Box's 16 MiB cap passes unchanged; one byte over is refused before the provider.
    const near = 16 * 1024 * 1024 - 4096;
    const big = await call(`${route}/responses`, "POST", near);
    assert.equal(big.status, 200, JSON.stringify(big));
    assert.equal(provider.requests.at(-1)!.bodyBytes, near);
    assert.equal(provider.requests.at(-1)!.bodySha256, big.bodySha256);
    const beforeOver = provider.requests.length;
    const over = await call(`${route}/responses`, "POST", 16 * 1024 * 1024 + 1);
    assert.notEqual(over.status, 200);
    assert.equal(provider.requests.length, beforeOver);
    evidence.nearCap = { bodyBytes: near, status: big.status, totalMs: big.totalMs, providerSha256Match: true };
    evidence.overCap = { bodyBytes: over.bodyBytes, status: over.status, error: over.error };

    // 5. Repository-only withdrawal: OCE refuses GitHub; the model keeps working.
    assert.equal((await git(["ls-remote", remote, "HEAD"])).code, 0);
    f.state.withdrawn = true;
    const repoRefused = await git(["ls-remote", remote, "HEAD"]);
    assert.notEqual(repoRefused.code, 0);
    assert.equal(f.host.answered.at(-1), "access_withdrawn");
    const stillModel = await call(`${route}/responses`);
    assert.equal(stillModel.status, 200);
    f.state.withdrawn = false;
    evidence.repositoryOnlyWithdrawal = { git: "refused", model: stillModel.status };

    // 6. Model withdrawal: the host's receipt; refused before any provider byte; GitHub still works.
    const status = await gateway.withdraw({
      namespace,
      revision: f.revision,
      sandbox: { id: "box-execution" } as never,
      sourceId: MODEL_SOURCE_ID,
      signal,
    });
    assert.equal(status.state, "revoked");
    const beforeWithdrawn = { requests: provider.requests.length, connections: provider.connections };
    const hostRefusedBefore = counts().refusedByHost;
    const answersBefore = f.host.answers;
    const withdrawn = await call(`${route}/responses`);
    assert.notEqual(withdrawn.status, 200);
    assert.deepEqual(
      { requests: provider.requests.length, connections: provider.connections },
      beforeWithdrawn,
      "no provider connection or byte after the revoke",
    );
    assert.equal(counts().refusedByHost, hostRefusedBefore + 1);
    assert.equal(f.host.answers, answersBefore, "the Worker was not asked");
    const gitAfter = await git(["ls-remote", remote, "HEAD"]);
    assert.equal(gitAfter.code, 0, gitAfter.stderr);
    assert.equal(f.host.answered.at(-1), "credential");
    evidence.modelWithdrawal = { model: withdrawn.status, error: withdrawn.error, git: "allowed" };

    // Nothing Box or the workload wrote holds a key: Box's state directory and output.
    let stateMatches = 0;
    const files = await listFiles(join(root, "box-state"));
    for (const file of files) {
      const content = await readFile(file).catch(() => Buffer.alloc(0));
      for (const value of keys) if (content.includes(value)) stateMatches++;
    }
    evidence.boxStateFiles = files.length;
    evidence.boxStateKeyMatches = stateMatches;
    evidence.boxOutputKeyMatches = keys.filter((value) => boxOutput.includes(value)).length;
    assert.equal(stateMatches, 0);
    assert.equal(evidence.boxOutputKeyMatches, 0);
    evidence.hostModelCounts = counts();
    evidence.workerModelOutcomes = f.host.answered.length;
    evidence.providerRequests = provider.requests.length;
    evidence.providerConnections = provider.connections;
    evidence.kubernetesCalls = [...new Set(kube.calls.map((line) => line.split(" ")[0]))].sort();

    await writeFile(join(queue, "stop"), "");
    evidence.exit = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 20_000)),
    ]);
    return evidence;
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}
