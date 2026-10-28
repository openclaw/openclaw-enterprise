/// <reference lib="es2024.promise" />

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { request } from "node:http";
import { request as requestHttps } from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { startCredentialServiceFixture } from "../fixtures/repository-credentials/service.mjs";
import {
  appendFile,
  cp,
  link,
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
import { basename, join, relative, resolve } from "node:path";
import test from "node:test";
import {
  bindReservedPortInProcess,
  reservePort,
  reservedPortArgs,
} from "../helpers/available-port.mjs";
import { socketDirectory } from "../helpers/socket-directory.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.mjs";
import { credentialClientPath } from "../fixtures/repository-credentials/runtime.mjs";
import type { RuntimeRepositoryBinding } from "../../apps/controller/src/drivers/repo/github/credentials/client/manifest.ts";
import type { ClientFiles } from "../../apps/controller/src/drivers/repo/github/credentials/client/config.ts";
import type {
  SafeConfigurationSummary,
  SessionStatus,
  ShutdownSummary,
} from "../../apps/controller/src/drivers/repo/credentials/service-contracts.ts";

interface PortReservation {
  port: number;
  reusePort: boolean;
  release(): Promise<void>;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface HealthResponse {
  status: number | undefined;
  body: { ready: boolean; protocolVersion: number };
}

interface PackageManifest {
  dependencies?: Record<string, string>;
}

interface MaterialManifest {
  version: 1;
  generation: string;
  bindings: Array<
    Pick<
      RuntimeRepositoryBinding,
      "repositoryRef" | "sessionId" | "deadlineWallMs" | "directory" | "client"
    >
  >;
}

type ServiceEvent =
  | { event: "started"; authority: string; tokenClass?: string }
  | ({ event: "shutdown" } & ShutdownSummary);

const root = resolve(".");
const moduleGuard = join(root, "tests/fixtures/repository-credentials/module-guard.ts");

test(
  "detached credential service and client run without workspace packages or node_modules",
  { timeout: 30000 },
  async (t) => {
    const temporary = await temporaryDirectory(t, "credential-package-");
    const sockets = await socketDirectory(t, "credential-package-", {
      longest: "prepared-git-use.sock",
    });
    const build = join(temporary, "build");
    // A root TypeScript build is a prerequisite; stage its actual emitted output.
    await stageArtifactInputs(build);
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
    // Make the real emitted signer reachable under a new name. The package
    // builder must reject its authority rather than relying on a filename list.
    const emittedCredentials = join(build, "apps/controller/dist/drivers/repo/github/credentials");
    await cp(
      join(emittedCredentials, "material.js"),
      join(emittedCredentials, "package-issuer-control.js"),
    );
    await appendFile(
      join(build, "apps/controller/dist/repository-credentials.js"),
      '\nimport "./drivers/repo/github/credentials/package-issuer-control.js";\n',
    );
    const issuerRejected = spawnSync(
      process.execPath,
      [join(build, "scripts/build-repository-credentials.mjs")],
      { encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH } },
    );
    assert.notEqual(issuerRejected.status, 0);
    assert.match(
      issuerRejected.stderr,
      /Unsupported service cryptographic capability in drivers\/repo\/github\/credentials\/package-issuer-control\.js/,
    );
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
    for (const module of [
      "material",
      "provider-transport",
      "prepared-owner",
      "prepared-lifecycle",
      "registry-factory",
      "descriptions",
      "token-source/app",
      "driver/acquisition",
      "driver/retirement",
    ]) {
      assert.ok(
        !emitted.includes(`drivers/repo/github/credentials/${module}.js`),
        `native package includes issuer module ${module}`,
      );
    }
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
    assert.ok(clientModules.includes("drivers/repo/github/credentials/client/draft-pr.js"));
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
    // Hold the gateway port across the prepared and development process launches.
    const serviceReservation: PortReservation = await reservePort();
    t.after(serviceReservation.release);
    const registryFile = join(temporary, "registry.json");
    await writeFile(
      registryFile,
      JSON.stringify({
        version: 1,
        backendId: "github-fixture",
        providerInstanceId: "fixture",
        appId: "123",
        githubInstallationId: "456",
        maximumDurationSeconds: 172800,
        repositories: [
          {
            repositoryRef: "project",
            repositoryId: "789",
            repository: "example/project",
            namespaces: [
              {
                namespaceId: "fixture",
                profiles: ["git-write"],
                transport: "git-only",
                pushRefAllowlist: ["refs/heads/agent-work"],
              },
            ],
          },
        ],
      }),
      { mode: 0o600 },
    );
    const configuration = join(temporary, "service.json");
    const preparedConfiguration = {
      gateway: {
        publicOrigin: "https://credentials.example.test",
        listen: `127.0.0.1:${serviceReservation.port}`,
        tlsCertFile: certificate,
        tlsKeyFile: key,
        controlSocket: join(sockets, "control.sock"),
      },
      sessionPolicy: {
        maximumDurationSeconds: 172800,
        defaultProfile: "git-write",
        allowedProfiles: ["git-read", "git-write", "git-full"],
      },
      backend: {
        kind: "github-prepared-git-registry",
        backendId: "github-fixture",
        registryFile,
      },
    };
    await writeFile(configuration, JSON.stringify(preparedConfiguration), { mode: 0o600 });
    const checked = spawnSync(
      process.execPath,
      [
        "--import",
        moduleGuard,
        join(runtime, "dist/composition/repository-credentials/check-config.js"),
        "--check-config",
        configuration,
      ],
      { cwd: runtime, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(
      checked.status,
      0,
      checked.stderr.split("\n", 1)[0] ?? "configuration check failed",
    );
    assert.equal(checked.stdout.includes("PRIVATE KEY"), false);
    const checkedSummary: SafeConfigurationSummary = JSON.parse(checked.stdout);
    assert.equal(checkedSummary.valid, true);
    // The development token authority needs the process flag in both argv parsers.
    const token = `gho_${"p".repeat(36)}`;
    const tokenFile = join(temporary, "token");
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    const tokenConfiguration = join(temporary, "token-service.json");
    const developmentConfiguration = {
      gateway: {
        ...preparedConfiguration.gateway,
        listen: `127.0.0.1:${serviceReservation.port}`,
        controlSocket: join(sockets, "token-control.sock"),
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
    };
    await writeFile(tokenConfiguration, JSON.stringify(developmentConfiguration), { mode: 0o600 });
    const entry = (script: string, args: string[]) => {
      const result = spawnSync(
        process.execPath,
        ["--import", moduleGuard, join(runtime, "dist", script), ...args],
        {
          cwd: runtime,
          env: {
            PATH: process.env.PATH,
            CREDENTIAL_TEST_TOKEN_FILE: tokenFile,
            CREDENTIAL_TEST_DEVELOPMENT: args.includes("--development-authority") ? "1" : "0",
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(
        result.stdout.includes(token) || result.stderr.includes(token),
        false,
        "emitted entrypoint exposed the fixture credential",
      );
      return result;
    };
    const checkConfig = "composition/repository-credentials/check-config.js";
    const preparedEntry = entry("repository-credentials.js", [
      "--config",
      configuration,
      "--check-config",
    ]);
    assert.equal(preparedEntry.status, 0, preparedEntry.stderr);
    const preparedSummary: SafeConfigurationSummary = JSON.parse(preparedEntry.stdout);
    assert.equal(preparedSummary.authority, "github-prepared-git-registry");
    const malformedOriginConfiguration = join(temporary, "malformed-origin.json");
    await writeFile(
      malformedOriginConfiguration,
      JSON.stringify({
        ...preparedConfiguration,
        backend: { ...preparedConfiguration.backend, gitOrigin: "not-an-origin" },
      }),
      { mode: 0o600 },
    );
    const malformedOrigin = entry(checkConfig, ["--check-config", malformedOriginConfiguration]);
    assert.deepEqual(
      [malformedOrigin.status, malformedOrigin.stderr],
      [1, "invalid-configuration\n"],
    );
    const retiredConfiguration = join(temporary, "retired.json");
    for (const kind of ["github-app", "github-app-registry"]) {
      await writeFile(
        retiredConfiguration,
        JSON.stringify({
          ...preparedConfiguration,
          backend: { kind, privateKeyFile: tokenFile },
        }),
        { mode: 0o600 },
      );
      const ordinary = entry(checkConfig, ["--check-config", retiredConfiguration]);
      const optedIn = entry(checkConfig, [
        "--check-config",
        retiredConfiguration,
        "--development-authority",
      ]);
      assert.equal(ordinary.status, 1);
      assert.match(ordinary.stderr, /^GitHub App signing gateway retired:/);
      assert.deepEqual([optedIn.status, optedIn.stderr], [ordinary.status, ordinary.stderr]);
      assert.equal(ordinary.stderr.includes("credential-test-token-open"), false);
    }
    const refused = entry(checkConfig, ["--check-config", tokenConfiguration]);
    assert.deepEqual([refused.status, refused.stderr], [1, "invalid-configuration\n"]);
    const missingConfigurationOptIn = join(temporary, "missing-development-opt-in.json");
    await writeFile(
      missingConfigurationOptIn,
      JSON.stringify({
        ...developmentConfiguration,
        backend: { ...developmentConfiguration.backend, developmentOnly: false },
      }),
      { mode: 0o600 },
    );
    const configurationRefused = entry(checkConfig, [
      "--check-config",
      missingConfigurationOptIn,
      "--development-authority",
    ]);
    assert.deepEqual(
      [configurationRefused.status, configurationRefused.stderr],
      [1, "invalid-configuration\n"],
    );
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
      assert.equal(result.stderr, "credential-test-token-open\n");
      const { authority, tokenClass }: SafeConfigurationSummary = JSON.parse(result.stdout);
      assert.deepEqual(
        { authority, tokenClass },
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
    // The prepared entrypoint starts without development authority modules.
    // A real protocol reply establishes completed startup before SIGTERM.
    const preparedRuntime = join(temporary, "prepared-runtime");
    await cp(runtime, preparedRuntime, { recursive: true });
    for (const module of ["factory.js", "driver.js", "static-token.js"]) {
      await rm(join(preparedRuntime, "dist/drivers/repo/github/credentials", module));
    }
    const preparedService = spawn(
      process.execPath,
      [
        ...reservedPortArgs(serviceReservation),
        "--import",
        moduleGuard,
        join(preparedRuntime, "dist/repository-credentials.js"),
        "--config",
        configuration,
      ],
      {
        cwd: preparedRuntime,
        env: { PATH: process.env.PATH, CREDENTIAL_TEST_DEVELOPMENT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
        killSignal: "SIGKILL",
      },
    );
    let preparedOutput = "";
    preparedService.stdout.on("data", (chunk) => (preparedOutput += chunk));
    preparedService.stderr.on("data", (chunk) => (preparedOutput += chunk));
    const preparedExit = new Promise<ProcessExit>((resolve, reject) => {
      preparedService.once("error", reject);
      preparedService.once("close", (code, signal) => resolve({ code, signal }));
    });
    try {
      await waitUntil(
        "the prepared service to answer its readiness probe",
        async () => {
          try {
            const health = await controlHealth(join(sockets, "control.sock"));
            return (
              health.status === 200 &&
              health.body.ready === true &&
              health.body.protocolVersion === 1
            );
          } catch {
            return false;
          }
        },
        { timeoutMs: 5000, intervalMs: 10 },
      );
      preparedService.kill("SIGTERM");
      assert.deepEqual(await preparedExit, { code: 0, signal: null });
      assert.equal(preparedOutput.includes(token), false);
    } finally {
      if (preparedService.exitCode === null && preparedService.signalCode === null) {
        preparedService.kill("SIGKILL");
      }
      await preparedExit;
    }
    const manifest: PackageManifest = JSON.parse(
      await readFile(join(runtime, "package.json"), "utf8"),
    );
    const clientManifest: PackageManifest = JSON.parse(
      await readFile(join(client, "package.json"), "utf8"),
    );
    assert.deepEqual(manifest.dependencies ?? {}, {});
    assert.deepEqual(clientManifest.dependencies ?? {}, {});
    // Detached operator admission is development-only. Prepared native admission
    // requires the real worker receipt owner and is covered by the PostgreSQL suite.
    await writeFile(
      configuration,
      JSON.stringify({
        ...developmentConfiguration,
        gateway: preparedConfiguration.gateway,
      }),
      { mode: 0o600 },
    );
    const service = spawn(
      process.execPath,
      [
        ...reservedPortArgs(serviceReservation),
        "--import",
        moduleGuard,
        join(runtime, "dist/repository-credentials.js"),
        "--config",
        configuration,
        "--development-authority",
      ],
      {
        cwd: runtime,
        env: { PATH: process.env.PATH, CREDENTIAL_TEST_DEVELOPMENT: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
        killSignal: "SIGKILL",
      },
    );
    let stdout = "";
    service.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    service.stderr.on("data", (chunk) => {
      stdout += chunk;
    });
    const exited = new Promise<ProcessExit>((resolve, reject) => {
      service.once("error", reject);
      service.once("close", (code, signal) => resolve({ code, signal }));
    });
    try {
      const socket = join(sockets, "control.sock");
      await waitUntil(
        "the emitted development process to report started",
        () => stdout.includes('"event":"started"') || service.exitCode !== null,
        { timeoutMs: 5000, intervalMs: 10 },
      );
      assert.equal(service.exitCode, null, "emitted process exited before startup");
      assert.ok(
        stdout.includes(
          '{"event":"started","authority":"github-token-development","tokenClass":"oauth"}\n',
        ),
      );
      // The control socket is bound after the gateway port, so the hold can end.
      await serviceReservation.release();
      const clientRoot = join(client, "dist/drivers/repo/github/credentials/client");
      const invoke = (entrypoint: string, args: string[], input?: string) =>
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
      const session: SessionStatus = JSON.parse(opened.stdout);
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
      const observedStatus: SessionStatus = JSON.parse(status.stdout);
      assert.equal(observedStatus.sessionId, session.sessionId);
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
      // Push-policy launchers require packaged hooks. The source-selected helper
      // can still consume these same private session files through its real CLI.
      const sourceFilled = spawnSync(
        process.execPath,
        [credentialClientPath("git-helper"), sessionDirectory, "get"],
        {
          cwd: root,
          env: { PATH: process.env.PATH },
          encoding: "utf8",
          input: "protocol=https\nhost=credentials.example.test\npath=example/project.git\n\n",
          timeout: 10000,
        },
      );
      assert.equal(sourceFilled.status, 0, "source-selected credential helper failed");
      assert.ok(sourceFilled.stdout.includes(`password=${bearer}\n`));
      assert.equal(sourceFilled.stderr.includes(bearer), false);
      // Stage the same immutable material contract consumed by the installed
      // preparer, then move it to its final path before asking the detached helper.
      const stagingRoot = join(temporary, "material-staging");
      const finalRoot = join(temporary, "material");
      await mkdir(stagingRoot, { mode: 0o700 });
      await mkdir(join(stagingRoot, "sessions"), { mode: 0o700 });
      const originalMetadata: ClientFiles = JSON.parse(
        await readFile(join(sessionDirectory, "client.json"), "utf8"),
      );
      const metadata: ClientFiles = {
        ...originalMetadata,
        client: { ...originalMetadata.client, pushRefAllowlist: ["refs/heads/agent/*"] },
      };
      await writeFile(join(sessionDirectory, "client.json"), JSON.stringify(metadata), {
        mode: 0o600,
      });
      const identity: [string, string] = ["project", session.sessionId];
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
        } satisfies MaterialManifest),
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
      const invokeHook = async (ref: string) => {
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
      const closedStatus: SessionStatus = JSON.parse(closed.stdout);
      assert.equal(closedStatus.state, "CLOSED");
      assert.equal(closedStatus.sessionId, session.sessionId);
      assert.deepEqual(await controlHealth(socket), {
        status: 200,
        body: { ready: true, protocolVersion: 1 },
      });
      service.kill("SIGTERM");
      assert.deepEqual(await exited, { code: 0, signal: null });
      assert.equal(
        stdout.includes(token) || stdout.includes(bearer),
        false,
        "emitted service exposed a fixture credential",
      );
      const summary = stdout
        .split("\n")
        .filter(Boolean)
        .map((line): ServiceEvent => JSON.parse(line))
        .find((event) => event.event === "shutdown");
      assert.ok(summary, "emitted service must report completed shutdown");
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
  const temporary = await temporaryDirectory(t, "credential-closure-");
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
    join(emitted, "drivers/repo/github/credentials/client/draft-pr.js"),
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
  const cases: Array<[label: string, source: string, target?: string, expected?: RegExp]> = [
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
  await t.test("a hard link to a module outside the emitted root", async () => {
    const outside = join(temporary, "outside.js");
    await writeFile(outside, "export {};\n");
    await rm(clientEntry);
    await link(outside, clientEntry);
    const built = spawnSync(
      process.execPath,
      [join(temporary, "scripts/build-repository-credentials.mjs"), "--client-only"],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(built.status, 1);
    assert.match(built.stderr, /Invalid client runtime module/);
  });
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
  const hooks: string[] = JSON.parse(
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

async function snapshot(directory: string) {
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
  const temporary = await temporaryDirectory(t, "credential-client-stage-");
  // Reference: the artifact builder on the current full controller output.
  const full = join(temporary, "full");
  await stageArtifactInputs(full);
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
  const ignored = (path: string) =>
    /(?:^|\/)(?:dist|node_modules)(?:\/|$)|\.log$/u.test(relative(root, path));
  const stage = join(temporary, "stage");
  let copied = 0;
  for (const name of ["repository-credentials-deps", "repository-client-build"]) {
    const recipeStage = stages.get(name);
    assert.ok(recipeStage, `runtime Dockerfile must define ${name}`);
    for (const [, flags, operands] of recipeStage.matchAll(/^COPY((?: --\S+)*) (.+)$/gmu)) {
      assert.ok(flags !== undefined);
      assert.ok(operands);
      if (flags.includes(" --from=")) {
        continue;
      }
      const paths = operands.trim().split(/\s+/u);
      const destination = paths.pop();
      assert.ok(destination, "COPY must have a destination");
      for (const source of paths) {
        const target =
          paths.length > 1 || destination.endsWith("/")
            ? join(stage, destination, basename(source))
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

// Exercise real HTTP parsing and the same private readiness response as the worker.
function controlHealth(socketPath: string): Promise<HealthResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, path: "/healthz", agent: false }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    outgoing.setTimeout(2000, () => outgoing.destroy(new Error("health-timeout")));
    outgoing.once("error", reject);
    outgoing.end();
  });
}

test(
  "credential readiness waits for pending control socket setup",
  { timeout: 10000 },
  async (t) => {
    // Hold the gateway port until the in-process listener binds it: a port only probed free
    // can be taken by a parallel test or this fixture's own upstreams first (run 40557988145).
    const reservation: PortReservation = await reservePort();
    t.after(() => reservation.release());
    await bindReservedPortInProcess(reservation);
    const port: number = reservation.port;
    const tls = await createTlsMaterial(t);
    const gatewayStatus = (): Promise<number | undefined> =>
      new Promise((resolve, reject) => {
        const outgoing = requestHttps(
          {
            hostname: "127.0.0.1",
            port,
            path: "/fixture/repository.git/info/refs?service=git-upload-pack",
            headers: { host: "credentials.example.test" },
            ca: tls.ca,
            agent: false,
          },
          (response) => {
            response.resume();
            response.once("error", reject);
            response.once("end", () => resolve(response.statusCode));
          },
        );
        outgoing.setTimeout(2000, () => outgoing.destroy(new Error("gateway-timeout")));
        outgoing.once("error", reject);
        outgoing.end();
      });
    const original = fs.chmod;
    const held = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    // Hold only the real listener's chmod. No startup or HTTP behavior is replaced.
    fs.chmod = async (path, mode) => {
      if (String(path).endsWith(".sock")) {
        held.resolve(String(path));
        await release.promise;
      }
      return original(path, mode);
    };
    syncBuiltinESMExports();
    let started = false;
    const starting = startCredentialServiceFixture(t, {
      tls,
      gateway: { listen: `127.0.0.1:${port}` },
    }).then((fixture) => {
      started = true;
      return fixture;
    });
    try {
      const socket = await Promise.race([
        held.promise,
        starting.then(() => {
          throw new Error("listener did not reach socket setup");
        }),
      ]);
      // Both listeners are bound once socket setup starts. Release the hold so every
      // connection below reaches the real listener, not the resetting reservation.
      await reservation.release();
      assert.ok((await lstat(socket)).isSocket(), "binding alone precedes readiness");
      await assert.rejects(controlHealth(socket), isConnectionReset);
      await assert.rejects(gatewayStatus(), isConnectionReset);
      assert.equal(started, false, "socket setup must finish before startup resolves");
      release.resolve();
      await starting;
      assert.equal(
        await gatewayStatus(),
        401,
        "the ready gateway must challenge unauthenticated Git",
      );
      assert.deepEqual(await controlHealth(socket), {
        status: 200,
        body: { ready: true, protocolVersion: 1 },
      });
    } finally {
      release.resolve();
      fs.chmod = original;
      syncBuiltinESMExports();
      await starting;
    }
  },
);

function isConnectionReset(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ECONNRESET" || error.code === "EPIPE")
  );
}

async function stageArtifactInputs(directory: string): Promise<void> {
  await mkdir(join(directory, "scripts"), { recursive: true });
  await cp(
    join(root, "scripts/build-repository-credentials.mjs"),
    join(directory, "scripts/build-repository-credentials.mjs"),
  );
  await cp(join(root, "apps/controller/dist"), join(directory, "apps/controller/dist"), {
    recursive: true,
  });
  await cp(
    join(root, "deploy/runtime/repository-credentials"),
    join(directory, "deploy/runtime/repository-credentials"),
    { recursive: true },
  );
  await symlink(join(root, "node_modules"), join(directory, "node_modules"));
}
