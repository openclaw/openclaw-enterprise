import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { cleanEnvironment, run } from "../fixtures/repository-credentials/process.mjs";
import {
  extractImageFile,
  removeImageFileContainer,
  type ImageFileArchiveOptions,
  type ImageFileCleanup,
  type ImageFileContainerReceipt,
  type ImageFileTextOptions,
} from "../../scripts/lib/image-file.ts";

const execute = promisify(execFile);

function isContainerReceipt(value: unknown): value is ImageFileContainerReceipt {
  return (
    typeof value === "object" && value !== null && "name" in value && typeof value.name === "string"
  );
}

for (const phase of [
  "create",
  "copy",
  "renamed copy",
  "unsettled create",
  "replaced create",
  "no default command",
]) {
  let name = `OpenShell image extraction removes its Docker container after ${phase} cancellation`;
  if (phase === "create") {
    name = "OpenShell image extraction reconciles lost create and removal replies";
  } else if (phase === "unsettled create") {
    name = "OpenShell image extraction removes a renamed container after delayed creation";
  } else if (phase === "replaced create") {
    name = "OpenShell image extraction preserves a replacement after losing the create reply";
  } else if (phase === "no default command") {
    name = "OpenShell image extraction works without an image default command";
  }
  test(
    name,
    { skip: process.env.OCC_TEST_DOCKER_COMPUTE_REAL !== "1", timeout: 90_000 },
    async (t) => {
      const image = process.env.OCC_DOCKER_RUNTIME_IMAGE ?? "";
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
      const cleanup: ImageFileCleanup[] = [];
      const resource = { name: `oce-extraction-${randomUUID()}` };
      const receipt = join(directory, "resource.json");
      const persist = () => writeFile(receipt, JSON.stringify(resource));
      let container: string | undefined;
      let pendingCreate: string[] | undefined;
      const filename = "/opt/oce/runtime/provenance.json";
      const destination = join(directory, "provenance.json");
      const reference = join(directory, "direct-copy.json");
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
            await run("docker", ["rm", "--force", "--volumes", container], { env });
          }
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
      function command(
        executable: string,
        args: string[],
        options: ImageFileArchiveOptions,
      ): Promise<Buffer>;
      function command(
        executable: string,
        args: string[],
        options?: ImageFileTextOptions,
      ): Promise<string>;
      async function command(
        executable: string,
        args: string[],
        options: ImageFileTextOptions | ImageFileArchiveOptions = {},
      ): Promise<string | Buffer> {
        if (options.encoding === "buffer") {
          return (await execute(executable, args, { env, signal: controller.signal, ...options }))
            .stdout;
        }
        if (args[0] === "create" && phase === "no default command") {
          // Docker's entrypoint override also clears the image's default CMD.
          // Only the extractor's explicit command can make this create valid.
          const imageIndex = args.indexOf(image);
          args = [...args.slice(0, imageIndex), "--entrypoint", "", ...args.slice(imageIndex)];
        }
        if (args[0] === "create" && phase === "unsettled create") {
          pendingCreate = args;
          controller.abort();
          controller.signal.throwIfAborted();
        }
        if (args[0] === "cp" && (phase === "copy" || phase === "renamed copy")) {
          if (phase === "renamed copy") {
            assert.ok(container);
            await run("docker", ["rename", container, `oce-renamed-${container}`], { env });
          }
          // Cancel after real Docker creation, exactly when extraction is dispatched.
          // Only cancellation is injected; creation, removal, and inspection use Docker.
          controller.abort();
        }
        if (args[0] === "cp" && phase === "no default command") {
          // Keep Docker's own copy as the independent reference for both extraction modes.
          await run(executable, ["cp", `${container}:${filename}`, reference], { env });
        }
        const result = await run(executable, args, {
          env,
          signal: controller.signal,
          ...options,
        });
        if (args[0] === "rm" && phase === "create") {
          // Docker removed the authenticated container, but its reply was lost.
          // A later cleanup must settle the known ID's absence despite both lost replies.
          throw new Error("Removal reply lost");
        }
        if (args[0] === "create") {
          container = result.stdout.trim();
          if (phase === "replaced create") {
            // Lose the reply after an unrelated container has taken the name.
            // Cleanup must authenticate the retained ownership label, not the name.
            await run("docker", ["rm", "--volumes", container], { env });
            container = (
              await run("docker", ["create", "--name", resource.name, image], { env })
            ).stdout.trim();
          }
          if (phase === "create" || phase === "replaced create") {
            // Docker completed creation, but cancellation prevents the helper
            // from accepting its reply. The owned name must still be removed.
            controller.abort();
            controller.signal.throwIfAborted();
          }
        }
        return result.stdout;
      }
      let expected: RegExp | { name: string } = { name: "AbortError" };
      if (phase === "copy" || phase === "renamed copy") {
        expected = /command cancelled/;
      } else if (phase === "create" || phase === "replaced create") {
        expected = /Image extraction and container cleanup failed/;
      }
      const extraction = extractImageFile({
        command,
        cleanup,
        image,
        filename,
        destination,
        resource,
        persist,
      });
      if (phase === "no default command") {
        await extraction;
        const expectedBytes = await readFile(reference);
        assert.deepEqual(await readFile(destination), expectedBytes);
        const metadata: unknown = JSON.parse(expectedBytes.toString("utf8"));
        assert.ok(typeof metadata === "object" && metadata !== null && "codex" in metadata);
        const codex = metadata.codex;
        assert.ok(
          typeof codex === "object" && codex !== null && "version" in codex && codex.version,
        );
        assert.equal(await remainingContainer(), "");

        const bounded = join(directory, "bounded.json");
        await extractImageFile({
          command,
          cleanup,
          image,
          filename,
          destination: bounded,
          maxBytes: 64 * 1024,
        });
        assert.deepEqual(await readFile(bounded), expectedBytes);
        assert.equal((await stat(bounded)).mode & 0o777, 0o600);
      } else {
        await assert.rejects(extraction, expected);
      }
      if (phase === "create") {
        // A fresh cleanup process has only the durable receipt after both replies were lost.
        const recovered: unknown = JSON.parse(await readFile(receipt, "utf8"));
        assert.ok(isContainerReceipt(recovered));
        assert.equal(recovered.containerId, container);
        await removeImageFileContainer({ command, resource: recovered });
        assert.equal(recovered.removed, true);
      }
      if (phase === "replaced create") {
        assert.equal(await remainingContainer(), container, "replacement must remain untouched");
        for (const operation of cleanup) {
          await assert.rejects(operation(), /container ownership changed/);
        }
        return;
      }
      if (pendingCreate) {
        // Complete the real Docker operation after the initial empty lookup.
        // This models delayed completion to prove retained cleanup ownership;
        // it does not claim to reproduce Docker daemon scheduling.
        container = (await run("docker", pendingCreate, { env })).stdout.trim();
        await run("docker", ["rename", container, `oce-renamed-${container}`], { env });
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
