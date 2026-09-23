import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
  chmod,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(".");

test(
  "detached credential service and client run without workspace packages or node_modules",
  { timeout: 30000 },
  async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "credential-package-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const build = join(temporary, "build");
    await mkdir(join(build, "scripts"), { recursive: true });
    await mkdir(join(build, "apps/controller/dist"), { recursive: true });
    await cp(
      join(root, "scripts/build-repository-credentials.mjs"),
      join(build, "scripts/build-repository-credentials.mjs"),
    );
    // Exercise the real artifact builder on the current controller output. A root
    // TypeScript build is a prerequisite; no detached source package exists.
    await cp(join(root, "apps/controller/dist"), join(build, "apps/controller/dist"), {
      recursive: true,
    });
    await cp(
      join(root, "deploy/runtime/repository-credentials"),
      join(build, "deploy/runtime/repository-credentials"),
      { recursive: true },
    );
    await symlink(join(root, "node_modules"), join(build, "node_modules"));
    const built = spawnSync(
      process.execPath,
      [join(build, "scripts/build-repository-credentials.mjs")],
      {
        encoding: "utf8",
        timeout: 30000,
        env: { PATH: process.env.PATH },
      },
    );
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const artifact = join(build, ".build/repository-credentials/service");
    const runtime = join(temporary, "runtime");
    await cp(artifact, runtime, { recursive: true });
    const emitted = await readdir(join(runtime, "dist"), { recursive: true });
    assert.ok(emitted.includes("composition/repository-credentials/check-config.js"));
    assert.ok(emitted.includes("repository-credentials.js"));
    assert.ok(emitted.includes("composition/repository-credentials/projected-inputs.js"));
    assert.ok(emitted.includes("composition/repository-credentials/probe.js"));
    assert.ok(emitted.every((path) => !path.endsWith(".ts") && !path.endsWith(".map")));
    assert.ok(!emitted.includes("index.js"));
    assert.ok(!emitted.includes("worker.js"));
    assert.deepEqual((await readdir(join(build, ".build/repository-credentials"))).sort(), [
      "client",
      "service",
    ]);
    const client = join(temporary, "client");
    await cp(join(build, ".build/repository-credentials/client"), client, { recursive: true });
    const clientModules = await readdir(join(client, "dist"), { recursive: true });
    assert.ok(
      clientModules
        .filter((path) => path.endsWith(".js"))
        .every(
          (path) =>
            path.startsWith("drivers/repo/github/credentials/client/") ||
            path === "drivers/repo/credentials/client-contracts.js",
        ),
    );
    assert.ok(clientModules.includes("drivers/repo/github/credentials/client/router.js"));
    assert.ok(clientModules.includes("drivers/repo/github/credentials/client/hook-dispatch.js"));
    assert.equal(
      (await lstat(join(client, "dist/drivers/repo/github/credentials/client/hooks/pre-push")))
        .mode & 0o111,
      0o111,
    );
    // Delete the emitted workspace and tooling links before starting either runtime.
    await rm(build, { recursive: true, force: true });
    // The detached runtime has no dependency graph or workspace source. Real PEM loading
    // and TLS validation still run before the non-network configuration check succeeds.
    const key = join(temporary, "key.pem");
    const certificate = join(temporary, "certificate.pem");
    const openssl = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        certificate,
        "-days",
        "1",
        "-subj",
        "/CN=credentials.example.test",
        "-addext",
        "subjectAltName=DNS:credentials.example.test",
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(openssl.status, 0);
    await chmod(key, 0o600);
    await chmod(certificate, 0o644);
    const reservation = createServer();
    await new Promise((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const port = reservation.address().port;
    await new Promise((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const configuration = join(temporary, "service.json");
    await writeFile(
      configuration,
      JSON.stringify({
        gateway: {
          publicOrigin: "https://credentials.example.test",
          listen: `127.0.0.1:${port}`,
          tlsCertFile: certificate,
          tlsKeyFile: key,
          controlSocket: join(temporary, "control.sock"),
        },
        sessionPolicy: {
          maximumDurationSeconds: 172800,
          defaultProfile: "git-write",
          allowedProfiles: ["git-read", "git-write", "git-full"],
        },
        backend: {
          kind: "github-app",
          providerInstanceId: "fixture",
          configVersion: "1",
          appId: "123",
          installationId: "456",
          repositoryId: "789",
          repository: "example/project",
          privateKeyFile: key,
        },
      }),
      { mode: 0o600 },
    );
    const checked = spawnSync(
      process.execPath,
      [
        join(runtime, "dist/composition/repository-credentials/check-config.js"),
        "--check-config",
        configuration,
      ],
      { cwd: runtime, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(JSON.parse(checked.stdout).valid, true);
    assert.equal(checked.stdout.includes("PRIVATE KEY"), false);
    const manifest = JSON.parse(await readFile(join(runtime, "package.json"), "utf8"));
    assert.deepEqual(manifest.dependencies ?? {}, {});
    assert.deepEqual(
      JSON.parse(await readFile(join(client, "package.json"), "utf8")).dependencies ?? {},
      {},
    );
    const service = spawn(
      process.execPath,
      [join(runtime, "dist/repository-credentials.js"), "--config", configuration],
      {
        cwd: runtime,
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
      },
    );
    let stdout = "";
    service.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    service.stderr.resume();
    const exited = new Promise((resolve, reject) => {
      service.once("error", reject);
      service.once("close", (code, signal) => resolve({ code, signal }));
    });
    try {
      const socket = join(temporary, "control.sock");
      const deadline = Date.now() + 5000;
      while (
        !(await lstat(socket).catch(() => undefined)) &&
        service.exitCode === null &&
        Date.now() < deadline
      ) {
        await delay(10);
      }
      assert.ok(
        (await lstat(socket)).isSocket(),
        "emitted process did not bind its control socket",
      );
      const clientRoot = join(client, "dist/drivers/repo/github/credentials/client");
      const invoke = (entrypoint, args, input) =>
        spawnSync(process.execPath, [join(clientRoot, entrypoint), ...args], {
          cwd: client,
          env: { PATH: process.env.PATH },
          encoding: "utf8",
          input,
          timeout: 10000,
        });
      // Admission and private file delivery use the detached operator and real Unix
      // listener. No upstream request or provider issuance is needed for admission.
      const sessionDirectory = join(temporary, "session");
      const opened = invoke("operator.js", [
        "open",
        "--socket",
        socket,
        "--duration-seconds",
        "60",
        "--output",
        sessionDirectory,
      ]);
      assert.equal(opened.status, 0, "emitted operator admission failed");
      const session = JSON.parse(opened.stdout);
      assert.equal(session.state, "OPEN");
      assert.equal((await lstat(join(sessionDirectory, "bearer"))).mode & 0o777, 0o600);
      const status = invoke("operator.js", [
        "status",
        "--socket",
        socket,
        "--session",
        session.sessionId,
      ]);
      assert.equal(status.status, 0, "emitted operator status failed");
      assert.equal(JSON.parse(status.stdout).sessionId, session.sessionId);
      const filled = invoke(
        "launch.js",
        [sessionDirectory, "git", "credential", "fill"],
        "protocol=https\nhost=credentials.example.test\npath=example/project.git\n\n",
      );
      assert.equal(filled.status, 0, "emitted launcher/helper failed");
      const bearer = (await readFile(join(sessionDirectory, "bearer"), "utf8")).trim();
      assert.ok(
        filled.stdout.includes(`password=${bearer}\n`),
        "emitted helper did not select the admitted bearer",
      );
      assert.equal(filled.stderr.includes(bearer), false);
      assert.equal(opened.stdout.includes(bearer), false);
      // Stage the same immutable material contract consumed by the installed
      // preparer, then move it to its final path before asking the detached helper.
      const stagingRoot = join(temporary, "material-staging");
      const finalRoot = join(temporary, "material");
      await mkdir(stagingRoot, { mode: 0o700 });
      await mkdir(join(stagingRoot, "sessions"), { mode: 0o700 });
      const metadata = JSON.parse(await readFile(join(sessionDirectory, "client.json"), "utf8"));
      metadata.client.pushRefAllowlist = ["refs/heads/agent/*"];
      await writeFile(join(sessionDirectory, "client.json"), JSON.stringify(metadata), {
        mode: 0o600,
      });
      const identity = ["project", session.sessionId];
      const directoryName = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
      const generation = createHash("sha256")
        .update(JSON.stringify([identity]))
        .digest("hex");
      await cp(sessionDirectory, join(stagingRoot, "sessions", directoryName), {
        recursive: true,
      });
      await writeFile(
        join(stagingRoot, "manifest.json"),
        JSON.stringify({
          version: 1,
          generation,
          bindings: [
            {
              repositoryRef: identity[0],
              sessionId: session.sessionId,
              deadlineWallMs: metadata.deadlineWallMs,
              directory: join(finalRoot, "sessions", directoryName),
              client: metadata.client,
            },
          ],
        }),
        { mode: 0o600 },
      );
      const prepared = invoke("native-git.js", ["prepare", stagingRoot, finalRoot]);
      assert.equal(prepared.status, 0, "detached native Git preparation failed");
      const nativeConfig = await readFile(join(stagingRoot, "gitconfig"), "utf8");
      assert.equal((await lstat(join(stagingRoot, "gitconfig"))).mode & 0o777, 0o600);
      assert.equal(nativeConfig.includes(bearer), false);
      const repeated = invoke("native-git.js", ["prepare", stagingRoot, finalRoot]);
      assert.equal(repeated.status, 1, "preparation must not replace published configuration");
      assert.equal(await readFile(join(stagingRoot, "gitconfig"), "utf8"), nativeConfig);
      await rename(stagingRoot, finalRoot);
      const nativeFilled = invoke(
        "git-helper.js",
        ["manifest", finalRoot, generation, "get"],
        "protocol=https\nhost=credentials.example.test\npath=EXAMPLE/PROJECT.git\n\n",
      );
      assert.equal(nativeFilled.status, 0, "detached manifest helper failed");
      assert.ok(nativeFilled.stdout.includes(`password=${bearer}\n`));
      assert.equal(nativeFilled.stderr.includes(bearer), false);
      // The executable wrappers and their detached imports must work without
      // the workspace. The full HTTP push is covered by the real-Git suite.
      const checkout = join(temporary, "git-checkout");
      assert.equal(spawnSync("/usr/bin/git", ["init", checkout], { encoding: "utf8" }).status, 0);
      const inputFile = join(temporary, "push-input");
      const invokeHook = async (ref) => {
        await writeFile(
          inputFile,
          "HEAD " + "1".repeat(40) + " " + ref + " " + "0".repeat(40) + "\n",
        );
        return invoke("launch.js", [
          sessionDirectory,
          "git",
          "-C",
          checkout,
          "hook",
          "run",
          "--to-stdin=" + inputFile,
          "pre-push",
          "--",
          "origin",
          metadata.client.gitRemote,
        ]);
      };
      assert.equal((await invokeHook("refs/heads/agent/allowed")).status, 0);
      const deniedPush = await invokeHook("refs/heads/main");
      assert.equal(deniedPush.status, 1);
      assert.match(deniedPush.stderr, /repository-push-ref-not-allowed/);
      // An unsupported command must reach the router's public error boundary;
      // a missing router or import cannot satisfy this detached-entrypoint check.
      const rejected = invoke("router.js", ["git", "status"]);
      assert.equal(rejected.status, 1);
      assert.equal(rejected.stdout, "");
      assert.equal(rejected.stderr, "unsupported-client-command\n");
      const closed = invoke("operator.js", [
        "close",
        "--socket",
        socket,
        "--session",
        session.sessionId,
      ]);
      assert.equal(closed.status, 0, "emitted operator close failed");
      assert.notEqual(JSON.parse(closed.stdout).state, "OPEN");
      service.kill("SIGTERM");
      assert.deepEqual(await exited, { code: 0, signal: null });
      const summary = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((event) => event.event === "shutdown");
      assert.equal(summary.graceExpired, false);
    } finally {
      if (service.exitCode === null && service.signalCode === null) {
        service.kill("SIGKILL");
      }
      await exited;
    }
  },
);

test("credential artifact builder rejects dependencies outside its emitted closure", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "credential-closure-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(join(temporary, "scripts"));
  const emitted = join(temporary, "apps/controller/dist");
  const entrypoint = join(emitted, "composition/repository-credentials/check-config.js");
  await mkdir(join(emitted, "composition/repository-credentials"), { recursive: true });
  await cp(
    join(root, "scripts/build-repository-credentials.mjs"),
    join(temporary, "scripts/build-repository-credentials.mjs"),
  );
  await cp(
    join(root, "deploy/runtime/repository-credentials"),
    join(temporary, "deploy/runtime/repository-credentials"),
    { recursive: true },
  );
  await symlink(join(root, "node_modules"), join(temporary, "node_modules"));
  const clientEntry = join(emitted, "drivers/repo/github/credentials/client/launch.js");
  for (const path of [
    join(emitted, "repository-credentials.js"),
    entrypoint,
    join(emitted, "composition/repository-credentials/projected-inputs.js"),
    join(emitted, "composition/repository-credentials/probe.js"),
    join(emitted, "drivers/repo/github/credentials/client/router.js"),
    clientEntry,
    join(emitted, "drivers/repo/github/credentials/client/operator.js"),
    join(emitted, "drivers/repo/github/credentials/client/git-helper.js"),
    join(emitted, "drivers/repo/github/credentials/client/native-git.js"),
    join(emitted, "drivers/repo/github/credentials/client/hook-dispatch.js"),
    join(emitted, "drivers/repo/github/credentials/client/router.js"),
  ]) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "export {};\n");
  }
  // Establish a valid fixture before testing policy failures; missing image
  // inputs must not satisfy an expected dependency rejection.
  const valid = spawnSync(
    process.execPath,
    [join(temporary, "scripts/build-repository-credentials.mjs")],
    { encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH } },
  );
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  const cases = [
    ["missing emitted dependency", 'import "./missing.js";'],
    ["workspace dependency", 'import "@openclaw-enterprise/occ";'],
    ["escaping dependency", 'import "../../../outside.js";'],
    ["nonliteral dynamic import", 'const target = "./other.js"; await import(target);'],
    ["alternate loader", 'import { createRequire } from "node:module";'],
    [
      "client imports a service module",
      'import "../../../../../composition/repository-credentials/check-config.js";',
      clientEntry,
      /Invalid client runtime module/,
    ],
  ];
  for (const [
    label,
    source,
    target = entrypoint,
    expected = /Unsupported|Invalid|ENOENT/,
  ] of cases) {
    await t.test(label, async () => {
      await writeFile(entrypoint, "export {};\n");
      await writeFile(clientEntry, "export {};\n");
      await writeFile(target, source);
      const built = spawnSync(
        process.execPath,
        [join(temporary, "scripts/build-repository-credentials.mjs")],
        {
          encoding: "utf8",
          timeout: 10000,
          env: { PATH: process.env.PATH },
        },
      );
      assert.notEqual(built.status, 0);
      assert.match(built.stderr, expected);
    });
  }
});

test("emitted credential Docker contexts contain only staged runtime inputs", async () => {
  // Rebuild the actual image inputs so stale contexts cannot satisfy this check.
  const built = spawnSync(process.execPath, ["scripts/build-repository-credentials.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    env: { PATH: process.env.PATH },
  });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const ignore = await readFile(
    join(root, "deploy/runtime/repository-credentials/.dockerignore"),
    "utf8",
  );
  const hooks = JSON.parse(
    await readFile(join(root, "deploy/runtime/repository-credentials/hooks.json"), "utf8"),
  );
  for (const name of ["service", "client"]) {
    const context = join(root, ".build/repository-credentials", name);
    assert.deepEqual((await readdir(context)).sort(), [".dockerignore", "dist", "package.json"]);
    assert.equal(await readFile(join(context, ".dockerignore"), "utf8"), ignore);
    const files = await readdir(join(context, "dist"), { recursive: true, withFileTypes: true });
    assert.ok(
      files.some((file) => file.isFile()),
      "the context must contain emitted modules",
    );
    assert.ok(
      files.every(
        (file) =>
          file.isDirectory() ||
          (file.isFile() &&
            (file.name.endsWith(".js") ||
              (name === "client" &&
                hooks.includes(file.name) &&
                relative(join(context, "dist"), file.parentPath) ===
                  "drivers/repo/github/credentials/client/hooks"))),
      ),
      "runtime contexts exclude declarations, source maps, compiler state and linked inputs",
    );
  }
});
