import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanEnvironment, run } from "../fixtures/repository-credentials/process.mjs";
import { extractOpenShellImageFile } from "../helpers/openshell-git-installation.mjs";

type CommandOptions = { signal?: AbortSignal; timeout?: number };

for (const phase of ["create", "copy", "unsettled create"]) {
  test(
    `OpenShell image extraction removes its Docker container after ${phase} cancellation`,
    { skip: process.env.OCC_TEST_DOCKER_COMPUTE_REAL !== "1", timeout: 90_000 },
    async (t) => {
      const image = process.env.OCC_DOCKER_RUNTIME_IMAGE;
      assert.ok(image, "Select an existing OCC_DOCKER_RUNTIME_IMAGE for the Docker cleanup proof");
      const directory = await mkdtemp(join(tmpdir(), "openshell-extraction-"));
      const env = cleanEnvironment(
        Object.fromEntries(
          ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG"]
            .filter((name) => process.env[name] !== undefined)
            .map((name) => [name, process.env[name]]),
        ),
      );
      const controller = new AbortController();
      const cleanup: (() => Promise<void>)[] = [];
      let container: string | undefined;
      let pendingCreate: string[] | undefined;
      const remainingContainer = async () =>
        (
          await run(
            "docker",
            ["ps", "--all", "--quiet", "--no-trunc", "--filter", `id=${container}`],
            { env },
          )
        ).stdout.trim();
      // The test owns this stopped container even when the regression leaves it behind.
      t.after(async () => {
        try {
          if (container && (await remainingContainer())) {
            await run("docker", ["rm", "--force", container], { env });
          }
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
      const command = async (
        executable: string,
        args: string[],
        options: CommandOptions = {},
      ): Promise<string> => {
        if (args[0] === "create" && phase === "unsettled create") {
          pendingCreate = args;
          controller.abort();
          controller.signal.throwIfAborted();
        }
        if (args[0] === "cp" && phase === "copy") {
          // Cancel after real Docker creation, exactly when extraction is dispatched.
          // Only cancellation is injected; creation, removal, and inspection use Docker.
          controller.abort();
        }
        const result = await run(executable, args, {
          env,
          signal: controller.signal,
          ...options,
        });
        if (args[0] === "create") {
          container = result.stdout.trim();
          if (phase === "create") {
            // Docker completed creation, but cancellation prevents the helper
            // from accepting its reply. The owned name must still be removed.
            controller.abort();
            controller.signal.throwIfAborted();
          }
        }
        return result.stdout;
      };
      await assert.rejects(
        extractOpenShellImageFile({
          command,
          cleanup,
          image,
          filename: "/etc/os-release",
          destination: join(directory, "os-release"),
        }),
        phase === "copy" ? /command cancelled/ : { name: "AbortError" },
      );
      if (pendingCreate) {
        // Complete the real Docker operation after the initial empty lookup.
        // This models delayed completion to prove retained cleanup ownership;
        // it does not claim to reproduce Docker daemon scheduling.
        container = (await run("docker", pendingCreate, { env })).stdout.trim();
        for (const operation of cleanup) {
          await operation();
        }
      }
      assert.ok(container, "Docker created the owned test container");
      assert.match(container, /^[a-f0-9]{64}$/);
      assert.equal(
        await remainingContainer(),
        "",
        "cancelled extraction left its container behind",
      );
      // Outer fixture cleanup remains safe after the immediate cleanup already succeeded.
      for (const operation of cleanup.reverse()) {
        await operation();
      }
    },
  );
}
