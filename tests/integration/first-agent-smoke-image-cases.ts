import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { postgresImage, runtimeNodeBaseImage } from "../../scripts/ci/fixture-support-images.mjs";
import {
  bakeReferences,
  providerImageDockerfile,
  providerImageTag,
  publishPostgresImage,
  smokeBakeDefinition,
  smokeImageEnvironment,
} from "../../scripts/ci/first-agent-smoke.mjs";
import { commandPath, writeCommand } from "../helpers/fake-commands.ts";

export function registerImageCases() {
  const bakeInput = {
    revision: "0123456789abcdef0123456789abcdef01234567",
    controllerTag: "127.0.0.1:5000/oce-smoke/controller:0123456789abcdef0123456789abcdef01234567",
    smokeRuntimeTag: "127.0.0.1:5000/oce-smoke/runtime:0123456789abcdef0123456789abcdef01234567",
    context: "/work/runtime-trust",
    providerContext: "/work/provider-image",
    nodeRuntimeBaseImage: `docker.io/library/node:24.22.1-bookworm-slim@sha256:${"a".repeat(64)}`,
    openclawSource: {
      commit: "b".repeat(40),
      sourceArchiveSha256: "c".repeat(64),
      buildTimestamp: "2026-01-02T03:04:05Z",
    },
    registryAddress: "172.17.0.3:5000",
    runtimeContext: undefined,
    caches: (role: string) => [`cache-${role}`],
  };
  const pushOutput = (name: string) =>
    `type=image,name=172.17.0.3:5000/oce-smoke/${name}:${bakeInput.revision},push=true,registry.insecure=true`;

  test("the smoke bake only pushes the controller and runtime images, and loads the provider image", () => {
    const { target } = smokeBakeDefinition({ ...bakeInput, load: false });
    assert.deepEqual(target["smoke-controller"].output, [pushOutput("controller")]);
    assert.deepEqual(target["smoke-runtime"].output, [pushOutput("runtime")]);
    assert.deepEqual(target["smoke-controller"].labels, {
      "org.opencontainers.image.revision": bakeInput.revision,
    });
    // The upstream source identity must remain distinct from the OCE revision.
    assert.ok(target["smoke-runtime-base"]);
    assert.deepEqual(target["smoke-runtime-base"].args, {
      OPENCLAW_COMMIT: bakeInput.openclawSource.commit,
      OPENCLAW_SOURCE_SHA256: bakeInput.openclawSource.sourceArchiveSha256,
      OPENCLAW_BUILD_TIMESTAMP: bakeInput.openclawSource.buildTimestamp,
      OCC_BUILD_REVISION: bakeInput.revision,
      SOURCE_DATE_EPOCH: "0",
    });
    const provider: unknown = Reflect.get(target, "smoke-provider");
    assert.deepEqual(provider, {
      context: "/work/provider-image",
      contexts: { "smoke-runtime-base": "target:smoke-runtime-base" },
      args: { NODE_RUNTIME_BASE_IMAGE: bakeInput.nodeRuntimeBaseImage },
      output: [`type=docker,name=oce-first-agent-smoke-model-provider:${bakeInput.revision}`],
    });
    for (const definition of Object.values(target)) {
      for (const output of "output" in definition ? definition.output : []) {
        assert.ok(!output.startsWith("type=docker") || Object.is(definition, provider), output);
      }
    }
  });

  test("an artifact-backed smoke derives trust and provider images without compiling a runtime", () => {
    const runtimeContext = `oci-layout:///work/verified-runtime@sha256:${"d".repeat(64)}`;
    for (const load of [false, true]) {
      const { target } = smokeBakeDefinition({ ...bakeInput, runtimeContext, load });
      // Both FROM (trust) and COPY --from (provider) must resolve the same verified
      // image. Keeping the source target here would silently reintroduce a cold build.
      assert.equal(target["smoke-runtime-base"], undefined);
      assert.deepEqual(target["smoke-runtime"].contexts, { "smoke-runtime-base": runtimeContext });
      assert.equal(target["smoke-runtime"].args.RUNTIME_IMAGE, "smoke-runtime-base");
      if (!load) {
        const provider: unknown = Reflect.get(target, "smoke-provider");
        assert.ok(typeof provider === "object" && provider !== null && "contexts" in provider);
        assert.deepEqual(provider.contexts, { "smoke-runtime-base": runtimeContext });
      }
    }
  });

  test("the prepared-Git bake still loads both images and builds no provider image", () => {
    const { target } = smokeBakeDefinition({ ...bakeInput, load: true });
    assert.deepEqual(target["smoke-controller"].output, [
      `type=docker,name=${bakeInput.controllerTag}`,
      pushOutput("controller"),
    ]);
    assert.deepEqual(target["smoke-runtime"].output, [
      `type=docker,name=${bakeInput.smokeRuntimeTag}`,
      pushOutput("runtime"),
    ]);
    const provider: unknown = Reflect.get(target, "smoke-provider");
    assert.equal(provider, undefined);
  });

  test("only the registry acceptance selects the loopback registry and the PostgreSQL copy", () => {
    const images = {
      registryContainer: "oce-first-agent-smoke-registry",
      controller: `127.0.0.1:5000/oce-smoke/controller@sha256:${"1".repeat(64)}`,
      runtime: `127.0.0.1:5000/oce-smoke/runtime@sha256:${"2".repeat(64)}`,
      postgres: `127.0.0.1:5000/oce-smoke/postgres@sha256:${"3".repeat(64)}`,
      modelDirectory: "/work/model",
      providerImage: undefined,
    };
    const common = {
      OCC_DEVELOPMENT_CONTROLLER_IMAGE: images.controller,
      OCC_KUBERNETES_RUNTIME_IMAGE: images.runtime,
      OCC_FIRST_AGENT_SMOKE_MODEL_DIRECTORY: images.modelDirectory,
    };
    assert.deepEqual(smokeImageEnvironment({ ...images, preparedGit: false }), {
      ...common,
      OCC_DEVELOPMENT_IMAGE_REGISTRY_CONTAINER: images.registryContainer,
      OCC_DEVELOPMENT_POSTGRES_IMAGE: images.postgres,
    });
    // The prepared-Git acceptance imports every image from an archive: neither
    // setting may reach Local Setup, even when a PostgreSQL copy exists.
    const repository = {
      OCC_DEVELOPMENT_REPOSITORY_IMAGE: `127.0.0.1:5000/oce-smoke/repository@sha256:${"4".repeat(64)}`,
      OCC_SKIPPER_IMAGE_REGISTRY_CONTAINER: images.registryContainer,
    };
    assert.deepEqual(smokeImageEnvironment({ ...images, preparedGit: true, repository }), {
      ...repository,
      ...common,
    });
  });

  test("bake metadata selects both pushed images by registry digest", () => {
    const digest = (character: string) => `sha256:${character.repeat(64)}`;
    const metadata = {
      "smoke-controller": { "containerimage.digest": digest("1") },
      "smoke-runtime": { "containerimage.digest": digest("2") },
      "smoke-provider": { "containerimage.config.digest": digest("3") },
    };
    assert.deepEqual(bakeReferences(metadata, bakeInput), [
      `127.0.0.1:5000/oce-smoke/controller@${digest("1")}`,
      `127.0.0.1:5000/oce-smoke/runtime@${digest("2")}`,
    ]);
    for (const name of ["smoke-controller", "smoke-runtime"] as const) {
      const incomplete = structuredClone(metadata);
      // A non-hex value, and hex digests one character short and one too long.
      for (const value of [
        "sha256:short",
        `sha256:${"1".repeat(63)}`,
        `sha256:${"1".repeat(65)}`,
      ]) {
        incomplete[name]["containerimage.digest"] = value;
        assert.throws(
          () => bakeReferences(incomplete, bakeInput),
          new RegExp(`no containerimage.digest for ${name}`),
        );
      }
    }
    // The provider runs by its per-slot, per-revision name, in either engine image store.
    assert.equal(
      providerImageTag(bakeInput.revision),
      `oce-first-agent-smoke-model-provider:${bakeInput.revision}`,
    );
  });

  test("the provider image is the runtime's pinned Node base with only the runtime's ws package", async () => {
    const dockerfile = await readFile(
      new URL("../../deploy/runtime/Dockerfile", import.meta.url),
      "utf8",
    );
    assert.match(
      runtimeNodeBaseImage(dockerfile),
      /^docker\.io\/library\/node:24\.22\.1-bookworm-slim@sha256:[a-f0-9]{64}$/,
    );
    assert.throws(
      () => runtimeNodeBaseImage("ARG NODE_RUNTIME_BASE_IMAGE=node:24-bookworm-slim\n"),
      /pins no/,
    );
    assert.deepEqual(providerImageDockerfile.trim().split("\n"), [
      "ARG NODE_RUNTIME_BASE_IMAGE",
      "FROM ${NODE_RUNTIME_BASE_IMAGE}",
      "COPY --from=smoke-runtime-base /app/node_modules/ws/ /app/node_modules/ws/",
      `RUN node -e 'if (typeof require("/app/node_modules/ws").WebSocketServer !== "function") process.exit(1)'`,
      "USER node",
    ]);
    // The stand-in loads ws from that path.
    const endpoint = await readFile(
      new URL("../fixtures/runtime-model-probe-endpoint.mjs", import.meta.url),
      "utf8",
    );
    assert.match(endpoint, /createRequire\("\/app\/node_modules\/ws\/package\.json"\)\("ws"\)/);
  });

  test("the smoke copies Local Setup's PostgreSQL pin, not another image", async () => {
    const source = await readFile(
      new URL("../../internal/occdev/openshell_k3d.go", import.meta.url),
      "utf8",
    );
    assert.equal(postgresImage, /developmentPostgres\s*=\s*"([^"]+)"/.exec(source)?.[1]);
    assert.match(postgresImage, /@sha256:[a-f0-9]{64}$/);
  });

  const pinnedPostgresId = `sha256:${"c".repeat(64)}`;

  // A fake engine and registry for publishPostgresImage. The registry serves
  // `manifest` under the digest the push reports, unless `servedDigest` differs.
  function postgresCopyFixture({
    config = pinnedPostgresId,
    servedDigest,
    status = 200,
    driverStatus = '[["Backing Filesystem","extfs"]]',
  }: { config?: string; servedDigest?: string; status?: number; driverStatus?: string } = {}) {
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.docker.distribution.manifest.v2+json",
        config: { digest: config },
        layers: [],
      }),
    );
    const digest = servedDigest ?? `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
    const commands: string[][] = [];
    const pulls: string[] = [];
    const fetches: Array<{
      url: string | URL | Request;
      accept: string;
      redirect: RequestRedirect | undefined;
    }> = [];
    return {
      commands,
      pulls,
      fetches,
      digest,
      pull: async (image: string) => {
        pulls.push(image);
      },
      runCommand: async (command: string, args: string[]) => {
        commands.push([command, ...args]);
        const joined = args.join(" ");
        if (joined === "info --format {{json .DriverStatus}}") {
          return { stdout: `${driverStatus}\n` };
        }
        if (joined === `image inspect --format {{.Id}} ${postgresImage}`) {
          return { stdout: `${pinnedPostgresId}\n` };
        }
        if (joined.startsWith("push ")) {
          return {
            stdout: `The push refers to repository [127.0.0.1:5000/oce-smoke/postgres]\n18.6: digest: ${digest} size: 3036\n`,
          };
        }
        return { stdout: "" };
      },
      fetchRegistry: async (url: string | URL | Request, init?: RequestInit) => {
        assert.ok(init?.headers && "accept" in init.headers);
        const accept: unknown = init.headers.accept;
        assert.ok(typeof accept === "string");
        fetches.push({ url, accept, redirect: init.redirect });
        return new Response(manifest, { status });
      },
    };
  }

  test("the PostgreSQL copy pulls the pin and returns the loopback registry digest", async () => {
    const fixture = postgresCopyFixture();
    const reference = await publishPostgresImage({ registry: "127.0.0.1:5000", ...fixture });
    assert.equal(reference, `127.0.0.1:5000/oce-smoke/postgres@${fixture.digest}`);
    assert.deepEqual(fixture.pulls, [postgresImage]);
    assert.deepEqual(fixture.commands, [
      ["docker", "info", "--format", "{{json .DriverStatus}}"],
      ["docker", "image", "inspect", "--format", "{{.Id}}", postgresImage],
      // Tagged by the verified image ID, never by a name that could resolve elsewhere.
      ["docker", "tag", pinnedPostgresId, "127.0.0.1:5000/oce-smoke/postgres:18.6"],
      ["docker", "push", "127.0.0.1:5000/oce-smoke/postgres:18.6"],
    ]);
    assert.deepEqual(fixture.fetches, [
      {
        url: `http://127.0.0.1:5000/v2/oce-smoke/postgres/manifests/${fixture.digest}`,
        accept:
          "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
        redirect: "error",
      },
    ]);
  });

  test("the PostgreSQL copy retains stdout progress from its signalled pull command", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "postgres-pull-progress-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const calls = join(directory, "calls.jsonl");
    const marker = join(directory, "pulled");
    // Exercise the default run/adapter path. The first inert pull is SIGKILLed,
    // producing the smoke executor's timeout shape; the second fails permanently.
    // This proves captured stdout survives the adapter, not a live Docker timeout.
    await writeCommand(
      directory,
      "docker",
      `import { appendFileSync, existsSync, writeFileSync, writeSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[0] === "info") {
  console.log("[]");
} else if (args[0] === "image" && args[1] === "inspect") {
  console.error("No such image");
  process.exit(1);
} else if (args[0] === "pull" && !existsSync(${JSON.stringify(marker)})) {
  writeFileSync(${JSON.stringify(marker)}, "first pull");
  writeSync(1, "aaaaaaaaaaaa: Downloading\\n");
  process.kill(process.pid, "SIGKILL");
} else {
  console.error("denied");
  process.exit(1);
}`,
      { interpreter: process.execPath },
    );
    const owner = new URL("../../scripts/ci/first-agent-smoke.mjs", import.meta.url).href;
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { publishPostgresImage } from ${JSON.stringify(owner)};
try {
  await publishPostgresImage({ registry: "127.0.0.1:5000" });
  throw new Error("unexpected publication");
} catch (error) {
  if (error.result?.stderr !== "denied\\n") throw error;
  console.log(JSON.stringify({ code: error.result.code, signal: error.result.signal }));
}`,
      ],
      { env: { ...process.env, PATH: commandPath(directory) }, timeout: 15_000 },
    );
    assert.deepEqual(JSON.parse(stdout), { code: 1, signal: null });
    assert.match(
      stderr,
      /Image pull attempt 1\/4 failed after \d+ ms \(timeout\).*aaaaaaaaaaaa: Downloading/,
    );
    assert.deepEqual(
      (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          const command: unknown = JSON.parse(line);
          assert.ok(Array.isArray(command));
          const first: unknown = command[0];
          return first;
        }),
      ["info", "image", "pull", "pull"],
    );
  });

  test("the PostgreSQL copy refuses a registry manifest that names another image", async () => {
    const fixture = postgresCopyFixture({ config: `sha256:${"e".repeat(64)}` });
    await assert.rejects(
      publishPostgresImage({ registry: "127.0.0.1:5000", ...fixture }),
      /the registry copy of PostgreSQL is not the pinned image/,
    );
  });

  test("the PostgreSQL copy refuses manifest bytes that do not match the recorded digest", async () => {
    const fixture = postgresCopyFixture({ servedDigest: `sha256:${"f".repeat(64)}` });
    await assert.rejects(
      publishPostgresImage({ registry: "127.0.0.1:5000", ...fixture }),
      /the registry manifest does not match/,
    );
  });

  test("the PostgreSQL copy needs a loopback registry and touches nothing otherwise", async () => {
    for (const registry of [
      "0.0.0.0:5000",
      "registry.example:5000",
      "127.0.0.1",
      "localhost:5000",
    ]) {
      const fixture = postgresCopyFixture();
      await assert.rejects(
        publishPostgresImage({ registry, ...fixture }),
        /the PostgreSQL copy needs a loopback registry/,
        registry,
      );
      assert.deepEqual([fixture.pulls, fixture.commands, fixture.fetches], [[], [], []], registry);
    }
  });

  test("the PostgreSQL copy refuses a registry that does not serve the pushed manifest", async () => {
    const fixture = postgresCopyFixture({ status: 404 });
    await assert.rejects(
      publishPostgresImage({ registry: "127.0.0.1:5000", ...fixture }),
      /registry manifest 127\.0\.0\.1:5000\/oce-smoke\/postgres@sha256:[a-f0-9]{64}: HTTP 404/,
    );
  });

  test("the PostgreSQL copy needs the digest docker push reports", async () => {
    const fixture = postgresCopyFixture();
    const runCommand = fixture.runCommand;
    fixture.runCommand = async (command, args) =>
      args[0] === "push" ? { stdout: "pushed\n" } : runCommand(command, args);
    await assert.rejects(
      publishPostgresImage({ registry: "127.0.0.1:5000", ...fixture }),
      /docker push reported no digest/,
    );
    assert.deepEqual(fixture.fetches, []);
  });

  test("with the containerd image store PostgreSQL keeps the archive path", async () => {
    const fixture = postgresCopyFixture({
      driverStatus: '[["driver-type","io.containerd.snapshotter.v1"]]',
    });
    assert.equal(await publishPostgresImage({ registry: "127.0.0.1:5000", ...fixture }), undefined);
    assert.deepEqual(fixture.pulls, []);
    assert.deepEqual(fixture.commands, [["docker", "info", "--format", "{{json .DriverStatus}}"]]);
  });
}
