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
import { setTimeout as delay } from "node:timers/promises";
import { reservePort, reservedPortArgs } from "../helpers/available-port.mjs";

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
    // Both services below bind a configured gateway port long after it is chosen. Hold each
    // port until its service has bound it, so no other socket takes it in between.
    const serviceReservation = await reservePort();
    t.after(serviceReservation.release);
    const developmentReservation = await reservePort();
    t.after(developmentReservation.release);
    const configuration = join(temporary, "service.json");
    await writeFile(
      configuration,
      JSON.stringify({
        gateway: {
          publicOrigin: "https://credentials.example.test",
          listen: `127.0.0.1:${serviceReservation.port}`,
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
    // The development token authority needs the process flag in both argv parsers.
    const token = `gho_${"p".repeat(36)}`;
    const tokenFile = join(temporary, "token");
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    const tokenConfiguration = join(temporary, "token-service.json");
    const appConfiguration = JSON.parse(await readFile(configuration, "utf8"));
    await writeFile(
      tokenConfiguration,
      JSON.stringify({
        gateway: {
          ...appConfiguration.gateway,
          listen: `127.0.0.1:${developmentReservation.port}`,
          controlSocket: join(temporary, "token-control.sock"),
        },
        sessionPolicy: {
          maximumDurationSeconds: 28800,
          defaultProfile: "git-write",
          allowedProfiles: ["git-read", "git-write"],
        },
        limits: { gitPushInputBytes: 67108864 },
        backend: {
          kind: "github-token",
          providerInstanceId: "fixture",
          configVersion: "1",
          repositoryId: "789",
          repository: "example/project",
          tokenFile,
          developmentOnly: true,
          pushRefAllowlist: ["refs/heads/agent/*"],
        },
      }),
      { mode: 0o600 },
    );
    const entry = (script, args) =>
      spawnSync(process.execPath, [join(runtime, "dist", script), ...args], {
        cwd: runtime,
        env: { PATH: process.env.PATH },
        encoding: "utf8",
        timeout: 10000,
      });
    const checkConfig = "composition/repository-credentials/check-config.js";
    const refused = entry(checkConfig, ["--check-config", tokenConfiguration]);
    assert.deepEqual([refused.status, refused.stderr], [1, "invalid-configuration\n"]);
    for (const result of [
      entry(checkConfig, ["--check-config", tokenConfiguration, "--development-authority"]),
      entry("repository-credentials.js", [
        "--config",
        tokenConfiguration,
        "--check-config",
        "--development-authority",
      ]),
    ]) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.includes(token), false);
      assert.deepEqual(
        (({ authority, tokenClass }) => ({ authority, tokenClass }))(JSON.parse(result.stdout)),
        { authority: "github-token-development", tokenClass: "oauth" },
      );
    }
    for (const args of [
      ["--config", tokenConfiguration, "--check-config"],
      ["--config", tokenConfiguration, "--check-config", "--bogus"],
      ["--config", tokenConfiguration, "--development-authority", "--development-authority"],
    ]) {
      const result = entry("repository-credentials.js", args);
      assert.deepEqual(
        [result.status, result.stderr],
        [1, "repository credential service failed\n"],
        args.join(" "),
      );
    }
    // A started development service names its authority and token class, never the token.
    const development = spawn(
      process.execPath,
      [
        ...reservedPortArgs(developmentReservation),
        join(runtime, "dist/repository-credentials.js"),
        "--config",
        tokenConfiguration,
        "--development-authority",
      ],
      {
        cwd: runtime,
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let developmentOutput = "";
    development.stdout.on("data", (chunk) => (developmentOutput += chunk));
    development.stderr.on("data", (chunk) => (developmentOutput += chunk));
    const developmentExit = new Promise((resolve) =>
      development.once("close", (code, signal) => resolve({ code, signal })),
    );
    try {
      const deadline = Date.now() + 5000;
      while (!developmentOutput.includes('"event":"started"') && Date.now() < deadline) {
        await delay(10);
      }
      assert.ok(
        developmentOutput.includes(
          '{"event":"started","authority":"github-token-development","tokenClass":"oauth"}\n',
        ),
        "development service did not report its authority",
      );
      // The service reports "started" after its listeners are bound.
      await developmentReservation.release();
      development.kill("SIGTERM");
      assert.deepEqual(await developmentExit, { code: 0, signal: null });
      assert.equal(developmentOutput.includes(token), false);
    } finally {
      if (development.exitCode === null && development.signalCode === null) {
        development.kill("SIGKILL");
      }
      await developmentExit;
    }
    const manifest = JSON.parse(await readFile(join(runtime, "package.json"), "utf8"));
    assert.deepEqual(manifest.dependencies ?? {}, {});
    assert.deepEqual(
      JSON.parse(await readFile(join(client, "package.json"), "utf8")).dependencies ?? {},
      {},
    );
    const service = spawn(
      process.execPath,
      [
        ...reservedPortArgs(serviceReservation),
        join(runtime, "dist/repository-credentials.js"),
        "--config",
        configuration,
      ],
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
      // The control socket is bound after the gateway port, so the hold can end.
      await serviceReservation.release();
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

async function snapshot(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
      .sort()
      .map(async (path) => {
        const stats = await lstat(join(directory, path));
        return {
          path,
          mode: stats.mode,
          sha256: stats.isFile()
            ? createHash("sha256")
                .update(await readFile(join(directory, path)))
                .digest("hex")
            : null,
        };
      }),
  );
}

test("runtime image client stage emits the full build's client from its own inputs", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "credential-client-stage-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  // Reference: the artifact builder on the current full controller output.
  const full = join(temporary, "full");
  await mkdir(join(full, "scripts"), { recursive: true });
  await cp(
    join(root, "scripts/build-repository-credentials.mjs"),
    join(full, "scripts/build-repository-credentials.mjs"),
  );
  await cp(join(root, "apps/controller/dist"), join(full, "apps/controller/dist"), {
    recursive: true,
  });
  await cp(
    join(root, "deploy/runtime/repository-credentials"),
    join(full, "deploy/runtime/repository-credentials"),
    { recursive: true },
  );
  await symlink(join(root, "node_modules"), join(full, "node_modules"));
  const reference = spawnSync(
    process.execPath,
    [join(full, "scripts/build-repository-credentials.mjs")],
    { encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH } },
  );
  assert.equal(reference.status, 0, reference.stdout + reference.stderr);

  // Stage: only the build-context paths the runtime Dockerfile copies into the
  // client stage and its dependency stage, so a missing input fails here.
  const recipe = await readFile(join(root, "deploy/runtime/Dockerfile"), "utf8");
  const stages = new Map(
    recipe.split(/^(?=FROM )/mu).map((stage) => [stage.match(/^FROM \S+ AS (\S+)$/mu)?.[1], stage]),
  );
  // Destinations below are relative to /build, and the root .dockerignore
  // drops dist, node_modules and log files from every COPY source.
  assert.match(
    stages.get("repository-credentials-deps") ?? "",
    /^FROM \S+ AS \S+\nWORKDIR \/build$/mu,
  );
  assert.doesNotMatch(stages.get("repository-client-build") ?? "", /^WORKDIR /mu);
  const ignored = (path) =>
    /(?:^|\/)(?:dist|node_modules)(?:\/|$)|\.log$/u.test(relative(root, path));
  const stage = join(temporary, "stage");
  let copied = 0;
  for (const name of ["repository-credentials-deps", "repository-client-build"]) {
    assert.ok(stages.has(name), `runtime Dockerfile must define ${name}`);
    for (const [, flags, operands] of stages.get(name).matchAll(/^COPY((?: --\S+)*) (.+)$/gmu)) {
      if (flags.includes(" --from=")) {
        continue;
      }
      const paths = operands.trim().split(/\s+/u);
      const destination = paths.pop();
      for (const source of paths) {
        const target =
          paths.length > 1 || destination.endsWith("/")
            ? join(stage, destination, source.split("/").pop())
            : join(stage, destination);
        await mkdir(join(target, ".."), { recursive: true });
        await cp(join(root, source), target, {
          recursive: true,
          filter: (path) => !ignored(path),
        });
        copied += 1;
      }
    }
  }
  assert.ok(copied > 0);
  await symlink(join(root, "node_modules"), join(stage, "node_modules"));
  const emitted = spawnSync(
    join(stage, "node_modules/.bin/tsc"),
    ["-p", "deploy/runtime/repository-credentials/tsconfig.client.json", "--pretty", "false"],
    { cwd: stage, encoding: "utf8", timeout: 60000, env: { PATH: process.env.PATH } },
  );
  assert.equal(emitted.status, 0, emitted.stdout + emitted.stderr);
  const built = spawnSync(
    process.execPath,
    ["scripts/build-repository-credentials.mjs", "--client-only"],
    {
      cwd: stage,
      encoding: "utf8",
      timeout: 30000,
      env: { PATH: process.env.PATH },
    },
  );
  assert.equal(built.status, 0, built.stdout + built.stderr);
  assert.deepEqual(await readdir(join(stage, ".build/repository-credentials")), ["client"]);
  assert.deepEqual(
    await snapshot(join(stage, ".build/repository-credentials/client")),
    await snapshot(join(full, ".build/repository-credentials/client")),
  );

  const rejected = spawnSync(
    process.execPath,
    ["scripts/build-repository-credentials.mjs", "--service-only"],
    {
      cwd: stage,
      encoding: "utf8",
      timeout: 30000,
      env: { PATH: process.env.PATH },
    },
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Usage: build-repository-credentials\.mjs \[--client-only\]/);
});
