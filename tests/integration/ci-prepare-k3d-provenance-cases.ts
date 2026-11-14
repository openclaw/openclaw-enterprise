import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  assertStderrMatch,
  fixtureImageCommands,
  immutableImage,
  nodeBaseImage,
} from "../helpers/ci-prepare-fixture.ts";
import { bashString } from "../helpers/fixture-command-server.ts";
import { interceptFixtureDocker } from "./ci-prepare-k3d-docker-fixture.ts";

export function registerRuntimeProvenanceCases() {
  for (const scenario of [
    "available",
    "manifest",
    "missing",
    "invalid",
    "directory",
    "oversized",
    "different-image",
    "cleanup-failed",
    "invalid-inventory",
    "cleanup-failed-once",
    "receipt-write-failed",
    "replaced-container",
    "lost-reply-replaced",
  ]) {
    test(`runtime provenance retains only verified metadata: ${scenario}`, async (t) => {
      const commands = await fixtureImageCommands(t, "success", "k3d-model", {
        NODE_BASE_IMAGE: nodeBaseImage,
        OCC_TEST_KUBERNETES_GATEWAY_IMAGE: immutableImage,
        OCC_TEST_KUBERNETES_AGENT_IMAGE: immutableImage,
        OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: immutableImage,
        OPENAI_API_KEY: "synthetic-model-key",
        OCC_TEST_OPENAI_MODEL: "synthetic-model",
        OCC_TEST_KUBERNETES_CODEX_VERSION: "not-reviewed",
      });
      const configId = `sha256:${"b".repeat(64)}`;
      const imageId = scenario === "manifest" ? `sha256:${"9".repeat(64)}` : configId;
      const containerId = "d".repeat(64);
      const canary = "private-provenance-must-not-be-uploaded";
      const metadata = {
        commit: "e".repeat(40),
        codex: {
          architecture: "amd64",
          version: scenario === "manifest" ? "0.164.0-alpha.1+build.2" : "0.164.0",
          binarySha256: "f".repeat(64),
          config: canary,
        },
        private: canary,
      };
      const metadataPath = join(dirname(commands.statePath), "provenance.json");
      if (scenario === "directory") {
        await mkdir(metadataPath);
        await writeFile(join(metadataPath, "unexpected"), canary);
      } else {
        await writeFile(
          metadataPath,
          scenario === "oversized"
            ? "x".repeat(128 * 1024)
            : JSON.stringify(
                scenario === "invalid"
                  ? { ...metadata, codex: { ...metadata.codex, binarySha256: canary } }
                  : metadata,
              ),
        );
      }
      const archivePath = join(dirname(commands.statePath), "provenance.tar");
      const archived = spawnSync("tar", [
        "--format=ustar",
        "-C",
        dirname(commands.statePath),
        "-cf",
        archivePath,
        "provenance.json",
      ]);
      assert.equal(archived.status, 0, archived.stderr.toString());
      let hostCopy = false;
      let containerPresent = false;
      const cleanupFailure = [
        "cleanup-failed",
        "invalid-inventory",
        "cleanup-failed-once",
        "receipt-write-failed",
        "replaced-container",
        "lost-reply-replaced",
      ].includes(scenario);
      const retainedContainer = [
        "cleanup-failed",
        "invalid-inventory",
        "replaced-container",
        "lost-reply-replaced",
      ].includes(scenario);
      let allowRemoval = !retainedContainer;
      let removalAttempts = 0;
      let brokenReceipt = false;
      if (scenario === "available") {
        await writeFile(
          `${commands.statePath}.diagnostics.json`,
          JSON.stringify({
            lane: "previous-lane",
            preparationId: "previous-attempt",
            failure: canary,
          }),
        );
      }
      let ownershipToken: string | undefined;
      const manifest = JSON.stringify({ config: { digest: configId } });
      const manifestDigest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
      let created = 0;
      await interceptFixtureDocker(t, commands, async (args) => {
        if (
          scenario === "manifest" &&
          args[0] === "image" &&
          args[1] === "inspect" &&
          args.includes("{{.Id}}")
        ) {
          return `printf '%s' ${bashString(imageId)}; exit 0`;
        }
        if (args[0] === "image" && args[1] === "inspect" && args.at(-1) === imageId) {
          // Docker 29 selects a platform manifest from the immutable image index.
          const selected = args.includes("--platform");
          const descriptor = selected
            ? { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: manifestDigest }
            : { mediaType: "application/vnd.oci.image.index.v1+json", digest: imageId };
          return `printf '%s' ${bashString(
            JSON.stringify([
              {
                Id: imageId,
                Os: "linux",
                Architecture: "amd64",
                ...(scenario === "manifest" ? { Descriptor: descriptor } : {}),
              },
            ]),
          )}; exit 0`;
        }
        if (scenario === "different-image" && args.includes("inspecti")) {
          return `printf '%s' ${bashString(
            JSON.stringify({
              status: {
                id: `sha256:${"a".repeat(64)}`,
                repoDigests: [args.at(-1)],
                pinned: true,
              },
            }),
          )}; exit 0`;
        }
        if (scenario === "manifest" && args.includes("content") && args.at(-1) === manifestDigest) {
          return `printf '%s' ${bashString(manifest)}; exit 0`;
        }
        if (args[0] === "create") {
          assert.equal(args[args.indexOf("--platform") + 1], "linux/amd64");
          assert.ok(
            args.includes(imageId),
            "copy from the immutable image, never its mutable build tag",
          );
          const state = await commands.readState();
          if (scenario === "manifest") {
            await writeFile(
              `${commands.statePath}.diagnostics.json`,
              JSON.stringify({
                lane: state.lane,
                preparationId: createHash("sha256").update(state.prefix).digest("hex"),
                currentAttempt: "retain",
              }),
            );
          }
          const recordedToken = state.resources.find(
            (resource) => resource.kind === "image-file",
          )?.ownershipToken;
          if (recordedToken !== undefined) {
            assert.ok(typeof recordedToken === "string", "expected an image-file ownership token");
          }
          ownershipToken = recordedToken;
          if (scenario === "lost-reply-replaced") {
            assert.ok(ownershipToken, "persist the ownership token before creating a container");
            assert.ok(args.includes(`org.openclaw.ci.image-file=${ownershipToken}`));
          }
          assert.ok(
            state.resources.some(
              (resource) => resource.kind === "image-file" && resource.name === args[2],
            ),
            "persist cleanup ownership before engine creation",
          );
          containerPresent = true;
          created += 1;
          if (scenario === "receipt-write-failed") {
            await rename(commands.statePath, `${commands.statePath}.backup`);
            await mkdir(commands.statePath);
            brokenReceipt = true;
          }
          return scenario === "lost-reply-replaced"
            ? "exit 1"
            : `printf '%s' ${bashString(containerId)}; exit 0`;
        }
        if (args[0] === "container" && args[1] === "inspect") {
          assert.ok(ownershipToken, "container inspection follows ownership registration");
          return `printf '%s' ${bashString(allowRemoval ? ownershipToken : "unrelated-owner")}; exit 0`;
        }
        if (args[0] === "cp") {
          assert.equal(args[1], `${containerId}:/opt/oce/runtime/provenance.json`);
          if (scenario === "missing") {
            // A failed acquisition must not accept valid-looking residual content.
            const state = await commands.readState();
            const cluster = state.resources.find((resource) => resource.kind === "k3d-cluster");
            const extraction = state.resources.find((resource) => resource.kind === "image-file");
            assert.ok(cluster?.directory, "expected the cluster's extraction directory");
            assert.ok(extraction, "expected a recorded image-file resource");
            await writeFile(
              join(cluster.directory, `${extraction.id}.json`),
              JSON.stringify(metadata),
            );
            return "exit 1";
          }
          if (args[2] === "-") {
            return `/bin/cat ${bashString(archivePath)}; exit 0`;
          }
          hostCopy = true;
          const destination = args[2];
          assert.ok(destination, "expected the copy destination");
          return `/bin/cp -R ${bashString(metadataPath)} ${bashString(destination)}; exit 0`;
        }
        if (
          args[0] === "ps" &&
          args.includes("--filter") &&
          args.at(-1)?.includes("-provenance-")
        ) {
          if (brokenReceipt) {
            await rm(commands.statePath, { recursive: true });
            await rename(`${commands.statePath}.backup`, commands.statePath);
            brokenReceipt = false;
          }
          if (scenario === "invalid-inventory" && !allowRemoval) {
            return `printf '%s' ${bashString(canary)}; exit 0`;
          }
          const observedId =
            scenario === "replaced-container" && !allowRemoval ? "e".repeat(64) : containerId;
          return `printf '%s' ${bashString(containerPresent ? observedId : "")}; exit 0`;
        }
        if (args[0] === "rm" && args.at(-1) === containerId) {
          removalAttempts += 1;
          assert.ok(args.includes("--volumes"), "remove anonymous extraction volumes");
          if (!allowRemoval || (scenario === "cleanup-failed-once" && removalAttempts === 1)) {
            return `printf '%s' ${bashString(canary)} >&2; exit 1`;
          }
          containerPresent = false;
          return "exit 0";
        }
      });
      const prepared = await commands.prepare();
      assert.equal(
        prepared.status,
        1,
        "the later unsupported seccomp version intentionally stops preparation",
      );
      assertStderrMatch(
        prepared.stderr,
        cleanupFailure ? /Runtime provenance cleanup failed/ : /limited to reviewed Codex versions/,
      );
      const state = await commands.readState();
      const expected = {
        imageId,
        manifestDigest: `sha256:${"c".repeat(64)}`,
        status: ["available", "manifest"].includes(scenario) ? "available" : "unavailable",
        ...(["available", "manifest"].includes(scenario)
          ? {
              platform: "linux/amd64",
              openclawCommit: metadata.commit,
              codex: { version: metadata.codex.version, binarySha256: "f".repeat(64) },
            }
          : {}),
      };
      const expectedRoles = {
        OCC_TEST_KUBERNETES_GATEWAY_IMAGE: expected,
        ...(cleanupFailure ? {} : { OCC_TEST_KUBERNETES_AGENT_IMAGE: expected }),
      };
      assert.deepEqual(state.runtimeProvenance, expectedRoles);
      const diagnostics = await readFile(`${commands.statePath}.diagnostics.json`, "utf8");
      const report = asRecord(JSON.parse(diagnostics));
      assert.ok(report, "expected a preparation diagnostics report");
      assert.deepEqual(report.runtimeProvenance, expectedRoles);
      assert.equal(report.preparationId, createHash("sha256").update(state.prefix).digest("hex"));
      assert.equal(report.lane, state.lane);
      if (scenario === "manifest") {
        assert.equal(report.currentAttempt, "retain");
      }
      assert.ok(!diagnostics.includes(canary));
      assert.ok(!prepared.stderr.includes(canary));
      assert.equal(
        created,
        scenario === "different-image" ? 0 : 1,
        "reuse one extraction for the shared image",
      );
      assert.equal(containerPresent, retainedContainer);
      if (!allowRemoval) {
        const failedCleanup = await commands.cleanup();
        assert.equal(failedCleanup.status, 1);
        assert.ok(!failedCleanup.stderr.includes(canary));
        assert.ok(
          (await commands.readState()).resources.some((resource) => resource.kind === "image-file"),
        );
        if (scenario === "cleanup-failed") {
          // Rejected receipt fields stay private, and failed cleanup retains its exact receipt.
          const retained = await commands.readState();
          for (const field of ["name", "owner"]) {
            const malformed = structuredClone(retained);
            const extraction = malformed.resources.find(
              (resource) => resource.kind === "image-file",
            );
            assert.ok(extraction, "expected the retained image-file receipt");
            extraction[field] = canary;
            await writeFile(commands.statePath, JSON.stringify(malformed));
            const rejected = await commands.cleanup();
            assert.equal(rejected.status, 1);
            assert.ok(!rejected.stderr.includes(canary));
            assert.deepEqual(await commands.readState(), malformed);
          }
          await writeFile(commands.statePath, JSON.stringify(retained));
        }
        allowRemoval = true;
      }
      await commands.cleanupSuccessfully();
      assert.equal(containerPresent, false);
      assert.equal(hostCopy, false, "metadata must be bounded before any host filesystem copy");
    });
  }
}
