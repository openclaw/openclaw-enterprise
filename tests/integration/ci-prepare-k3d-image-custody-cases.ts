import type {} from "./ci-prepare-k3d-agent-sandbox-child.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultK3sImage } from "../../scripts/ci/prepare.mjs";
import {
  assertStderrMatch,
  fixtureImageCommands,
  immutableImage,
  nodeBaseImage,
} from "../helpers/ci-prepare-fixture.ts";
import { eachSettled } from "../helpers/child-processes.mjs";
import { bashString } from "../helpers/fixture-command-server.ts";
import { interceptFixtureDocker } from "./ci-prepare-k3d-docker-fixture.ts";

export function registerHostImageCustodyCases() {
  test("k3d preparation reuses only matching local immutable images and verifies fresh pulls", async (t) => {
    await eachSettled(
      [
        "local-digest",
        "image-absent",
        "podman-image-absent",
        "image-absent-late-stderr",
        "local-mismatch",
        "pull-mismatch",
        "inspect-failed",
      ],
      async (scenario: string) => {
        const commands = await fixtureImageCommands(t, scenario, "k3d-model", {
          NODE_BASE_IMAGE: nodeBaseImage,
          // Supply the controller artifact so this case isolates image import, not its build.
          OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: immutableImage,
          OPENAI_API_KEY: "test-only-key",
          OCC_TEST_OPENAI_MODEL: "test-model",
          OCC_TEST_KUBERNETES_GATEWAY_IMAGE: immutableImage,
          OCC_TEST_KUBERNETES_AGENT_IMAGE: immutableImage,
          // Stop at the next independent preparation boundary after image import.
          OCC_TEST_KUBERNETES_CODEX_VERSION: "0.153.0",
        });
        const result = await commands.prepare();
        assert.equal(result.status, 1);
        const calls = await commands.commands();
        const pulls = calls.filter(
          ({ command, args }) => ["docker", "podman"].includes(command) && args[0] === "pull",
        );
        assert.equal(
          pulls.length,
          ["local-digest", "inspect-failed"].includes(scenario) ? 0 : 1,
          scenario,
        );
        const state = await commands.readState();
        const imported = state.resources.filter(({ kind }) => kind === "k3d-image");
        if (scenario === "pull-mismatch") {
          assertStderrMatch(
            result.stderr,
            /pull did not materialize the requested registry digest/,
          );
          assert.equal(imported.length, 0);
        } else if (scenario === "inspect-failed") {
          assertStderrMatch(result.stderr, /Cannot connect to the Docker daemon/);
          assert.equal(imported.length, 0);
        } else {
          assertStderrMatch(result.stderr, /limited to reviewed Codex versions/);
          assert.equal(imported.length, 1);
          const [image] = imported;
          assert.ok(image, "expected the imported immutable image");
          assert.equal(image.status, "ready");
          assert.equal(image.sourceImage, immutableImage);
          assert.equal(image.hostImageId, `sha256:${"b".repeat(64)}`);
        }
        await commands.cleanupSuccessfully();
        assert.ok(
          !(await commands.commands()).some(
            ({ args }) => args[0] === "image" && args[1] === "rm" && args.includes(immutableImage),
          ),
          "cleanup must preserve the caller's immutable source image",
        );
      },
    );
  });

  test("k3d preparation times out a hung host image command and never pulls for it", async (t) => {
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const imported = String.raw`localhost/\S+`;
    const timeouts: readonly [scenario: string, shown: string][] = [
      [
        "hung-host-digests",
        escape(`image inspect --format {{json .RepoDigests}} ${immutableImage}`),
      ],
      ["hung-host-id", escape(`image inspect --format {{.Id}} ${immutableImage}`)],
      ["hung-host-tag", `${escape(`tag ${immutableImage} `)}${imported}`],
      [
        "hung-host-platform",
        `${escape("image inspect --format {{.Os}}/{{.Architecture}} ")}${imported}`,
      ],
    ];
    await eachSettled(timeouts, async ([scenario, shown]: (typeof timeouts)[number]) => {
      const commands = await fixtureImageCommands(t, scenario, "k3d-model", {
        NODE_BASE_IMAGE: nodeBaseImage,
        OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: immutableImage,
        OPENAI_API_KEY: "test-only-key",
        OCC_TEST_OPENAI_MODEL: "test-model",
        OCC_TEST_KUBERNETES_GATEWAY_IMAGE: immutableImage,
        OCC_TEST_KUBERNETES_AGENT_IMAGE: immutableImage,
        OCC_TEST_KUBERNETES_CODEX_VERSION: "0.153.0",
        OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS: "3000",
      });
      const result = await commands.prepare();
      assert.equal(result.status, 1, scenario);
      assertStderrMatch(
        result.stderr,
        new RegExp(String.raw`The container engine did not answer within 3000 ms \(${shown}\)\.`),
        scenario,
      );
      // A timeout is not an absent image: nothing pulls, and nothing reaches the cluster.
      const calls = await commands.commands();
      assert.equal(
        calls.filter(
          ({ command, args }) => ["docker", "podman"].includes(command) && args[0] === "pull",
        ).length,
        0,
        scenario,
      );
      assert.equal(
        calls.some(({ args }) => args[0] === "exec" && args[1] === "-i"),
        false,
        scenario,
      );
      const state = await commands.readState();
      assert.equal(
        state.resources.some(({ kind, status }) => kind === "k3d-image" && status === "ready"),
        false,
        scenario,
      );
      await commands.cleanupSuccessfully();
    });
  });
}

export function registerAgentSandboxImageCustodyCase() {
  // Exercise the prepare-lane closure, importer journal and ordinary cleanup. Only
  // unrelated installation/bootstrap dependencies are substituted; the real preload
  // derives the native selection and calls the real registration closure twice.
  test("Agent Sandbox preparation imports its native cache and verifies reuse", async (t) => {
    const repository = "registry.k8s.io/agent-sandbox/agent-sandbox-controller";
    const child = "sha256:c28ca6f2366160f2470013c4588821cf7ebd21538d62c1016b6afc93583830d6";
    const index = "sha256:dbbad861e6c2cc0df1f7ec37dd0e2827b3d2bc051eb45855e01f94e697440403";
    const config = "sha256:5b6c81129dc7491b3d260940e34ff68323fb6f7f21450d42129be5169e52ab17";
    const source = `${repository}:v0.5.2@${child}`;
    const cached = `${repository}:v0.5.2@${index}`;
    // Re-encode the independent pinned manifest to model transport changing its
    // digest without changing the selected native config.
    const content =
      JSON.stringify(
        JSON.parse(
          readFileSync(
            new URL("../fixtures/agent-sandbox-v0.5.2-amd64-manifest.json.txt", import.meta.url),
            "utf8",
          ),
        ),
      ) + "\n";
    const transport = "sha256:" + createHash("sha256").update(content).digest("hex");
    assert.notEqual(transport, child);
    for (const scenario of [
      "index-only",
      "config-id",
      "lost-descriptor",
      "falsy-descriptor",
      "inspect-error",
      "mixed-error",
      "reuse-config",
      "reuse-cri",
    ]) {
      await t.test(scenario, async (t) => {
        const commands = await fixtureImageCommands(t, "success", "openshell", {
          NODE_BASE_IMAGE: nodeBaseImage,
          CODEX_ACCESS_TOKEN: "synthetic-native-preparation-token",
          OPENAI_API_KEY: "synthetic-native-preparation-key",
          OCC_TEST_OPENAI_MODEL: "synthetic-model",
          OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: immutableImage,
          OCC_TEST_KUBERNETES_GATEWAY_IMAGE: immutableImage,
          OCC_TEST_KUBERNETES_AGENT_IMAGE: immutableImage,
        });
        const root = dirname(commands.statePath);
        const reused = join(root, "reuse");
        const body = join(root, "manifest.json");
        await writeFile(body, content);
        const calls: (readonly string[])[] = [];
        let tag: string | undefined;
        let reference: string | undefined;
        let removedHost = false;
        const removedNode = new Set<string>();
        const localImage = {
          RepoDigests: [`${repository}@${index}`],
          Os: "linux",
          Architecture: "amd64",
        };
        const held = {
          ...localImage,
          ...(scenario === "config-id"
            ? { Id: config }
            : scenario === "falsy-descriptor"
              ? { Id: config, Descriptor: false }
              : {
                  Id: index,
                  Descriptor: {
                    digest: index,
                    mediaType: "application/vnd.oci.image.index.v1+json",
                  },
                }),
        };
        const selected = {
          ...localImage,
          ...(scenario === "lost-descriptor"
            ? { Id: config }
            : {
                Id: child,
                Descriptor: {
                  digest: child,
                  mediaType: "application/vnd.oci.image.manifest.v1+json",
                  platform: { os: "linux", architecture: "amd64" },
                },
              }),
        };
        await interceptFixtureDocker(t, commands, async (args) => {
          calls.push(args);
          const output = (value: unknown) =>
            `printf '%s\\n' ${bashString(JSON.stringify(value))}; exit 0`;
          if (args[0] === "image" && args[1] === "inspect" && args.at(-1) === source) {
            const diagnostic =
              scenario === "inspect-error"
                ? "Cannot connect to the Docker daemon"
                : scenario === "mixed-error"
                  ? `Cannot connect to the Docker daemon: No such image: ${source}`
                  : `Error response from daemon: No such image: ${source}`;
            return `printf '%s\\n' ${bashString(diagnostic)} >&2; exit 1`;
          }
          if (args[0] === "image" && args[1] === "inspect" && args.at(-1) === cached) {
            if (args.includes("--platform")) {
              assert.notEqual(
                scenario,
                "config-id",
                "verified single-native cache needs no optional platform inspect",
              );
              return output([selected]);
            }
            return output([held]);
          }
          if (args[0] === "pull" && args[1]?.startsWith(repository)) {
            return "echo offline-registry >&2; exit 61";
          }
          if (args[0] === "tag" && args[1]?.startsWith(repository)) {
            assert.equal(
              args[1],
              cached,
              "stage the locally available index, not its absent child alias",
            );
            tag = args[2];
            return "exit 0";
          }
          if (tag && args[0] === "image" && args[1] === "save" && args.at(-1) === tag) {
            assert.deepEqual(args, ["image", "save", "--platform", "linux/amd64", tag]);
            return "printf native-archive; exit 0";
          }
          if (tag && args[0] === "image" && args[1] === "rm" && args.at(-1) === tag) {
            removedHost = true;
            return "exit 0";
          }
          if (tag && args[0] === "exec") {
            if (args[1] === "-i") {
              return "/bin/cat >/dev/null; exit 0";
            }
            const operation = args.slice(2).join(" ");
            if (operation === "ctr -n k8s.io images list") {
              return `printf '%s\\n' ${bashString(`${tag} application/vnd.oci.image.manifest.v1+json ${transport} 1 linux/amd64 -`)} ${reference ? bashString(`${reference} application/vnd.oci.image.manifest.v1+json ${transport} 1 linux/amd64 -`) : ""}; exit 0`;
            }
            if (operation.startsWith("ctr -n k8s.io images tag ")) {
              reference = args.at(-1);
              return "exit 0";
            }
            if (operation.startsWith("ctr -n k8s.io images label ")) {
              return "exit 0";
            }
            if (operation.startsWith("ctr -n k8s.io images rm ")) {
              const removed = args.at(-1);
              assert.ok(removed, "expected the acquired node image to remove");
              removedNode.add(removed);
              return "exit 0";
            }
            if (operation === `ctr -n k8s.io content get ${transport}`) {
              const present = await stat(reused).then(
                () => true,
                () => false,
              );
              return present && scenario === "reuse-config"
                ? 'printf \'{"config":{"digest":"wrong"}}\'; exit 0'
                : `/bin/cat ${bashString(body)}; exit 0`;
            }
            if (operation === `crictl inspecti ${reference}`) {
              const present = await stat(reused).then(
                () => true,
                () => false,
              );
              return output({
                status: {
                  id: present && scenario === "reuse-cri" ? `sha256:${"f".repeat(64)}` : config,
                  repoDigests: [reference],
                  pinned: true,
                },
              });
            }
          }
          return undefined;
        });
        const helper = fileURLToPath(
          new URL("./ci-prepare-k3d-agent-sandbox-child.ts", import.meta.url),
        );
        const result = await commands.runShell(
          `node --experimental-test-module-mocks ${bashString(helper)} ${bashString(commands.statePath)} ${bashString(defaultK3sImage)}`,
        );
        assert.equal(result.status, 1, result.stderr);
        const state = await commands.readState();
        const imported = state.resources.filter(
          (resource) =>
            resource.kind === "k3d-image" && resource.envName === "Agent Sandbox controller",
        );
        if (["inspect-error", "mixed-error"].includes(scenario)) {
          assertStderrMatch(result.stderr, /Cannot connect to the Docker daemon/, scenario);
          assert.equal(imported.length, 0);
          assert.equal(tag, undefined);
        } else if (["lost-descriptor", "falsy-descriptor"].includes(scenario)) {
          assertStderrMatch(
            result.stderr,
            /(?:lost its descriptor|invalid local image descriptor)/,
            scenario,
          );
          assert.equal(imported.length, 0);
          assert.equal(tag, undefined);
        } else {
          assertStderrMatch(
            result.stderr,
            scenario === "reuse-config"
              ? /imported manifest does not match/
              : scenario === "reuse-cri"
                ? /imported CRI image does not match/
                : /native-registration-complete/,
            scenario,
          );
          assert.equal(imported.length, 1);
          const [image] = imported;
          assert.ok(image, "expected the imported Agent Sandbox controller");
          assert.ok(tag, "expected the acquired host image tag");
          assert.equal(image.status, "ready");
          assert.equal(image.sourceImage, source);
          assert.equal(image.acquisitionReference, cached);
          assert.equal(image.hostImageId, held.Id);
          assert.equal(image.reference, reference);
          assert.equal(reference, tag.replace(/:local$/, "") + "@" + transport);
          assert.deepEqual(image.nativeSelection, {
            platform: "linux/amd64",
            configDigest: config,
            cacheIndex: cached,
          });
          assert.equal(calls.filter((args) => args[0] === "tag" && args[1] === cached).length, 1);
          assert.equal(
            calls.filter(
              (args) => args[0] === "image" && args[1] === "inspect" && args.at(-1) === source,
            ).length,
            1,
            "reuse must not reacquire the source",
          );
          assert.match(await readFile(join(root, "result-0"), "utf8"), /imagePullPolicy: Never/);
        }
        assert.equal(
          calls.filter((args) => args[0] === "pull" && args[1]?.startsWith(repository)).length,
          0,
        );
        await commands.cleanupSuccessfully();
        if (tag) {
          assert.equal(removedHost, true);
          assert.ok(reference && removedNode.has(reference));
        }
        assert.ok(
          !calls.some(
            (args) =>
              args[0] === "image" &&
              args[1] === "rm" &&
              [source, cached].some((image) => image === args.at(-1)),
          ),
        );
      });
    }
  });
}
