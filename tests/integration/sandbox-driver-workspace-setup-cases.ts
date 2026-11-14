import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { OpenShellSandboxExecRequest } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { WorkspaceSetup } from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

type InitialWorkspaceSetup = WorkspaceSetup & {
  files: { "AGENTS.md": string };
};

export async function runNativeWorkspaceSetupCase(
  t: TestContext,
  execution: OpenShellSandboxExecRequest,
  setup: InitialWorkspaceSetup,
): Promise<void> {
  await t.test(
    "native initializer serializes retries and preserves later edits",
    {
      skip: process.env.OCC_TEST_RUNTIME_IMAGE
        ? false
        : "Set OCC_TEST_RUNTIME_IMAGE to the pinned native runtime.",
    },
    async (t) => {
      const image = process.env.OCC_TEST_RUNTIME_IMAGE;
      assert.ok(image);
      const [entrypoint, ...args] = execution.command;
      assert.ok(entrypoint);
      const mountPath = execution.environment.OPENCLAW_WORKSPACE_DIR;
      assert.ok(mountPath);
      const root = await temporaryDirectory(t, "openshell-workspace-setup-");
      assert.ok(process.getuid && process.getgid);
      const user = `${process.getuid()}:${process.getgid()}`;
      const workspace = join(root, "workspace");
      const home = join(root, "home");
      await mkdir(workspace);
      await mkdir(home);
      // Execute the exact command produced by provisionHarness with the real native CLI.
      // The separate live Sandbox proof covers the OpenShell transport.
      const execute = async (input: string) => {
        const name = `oce-workspace-setup-${randomUUID()}`;
        try {
          await runDocker(
            [
              "run",
              "--rm",
              "--name",
              name,
              "--interactive",
              "--pull=never",
              "--network",
              "none",
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges",
              "--user",
              user,
              // The concurrent initializer containers share these test-owned mounts on SELinux.
              "--volume",
              `${workspace}:${mountPath}:z`,
              "--volume",
              `${home}:/sandbox/.openclaw-runtime/home:z`,
              ...Object.entries(execution.environment).flatMap(([key, value]) => [
                "--env",
                `${key}=${value}`,
              ]),
              "--entrypoint",
              entrypoint,
              image,
              ...args,
            ],
            { encoding: "utf8", timeout: (execution.timeoutSeconds + 5) * 1_000 },
            input,
          );
        } catch (error) {
          // A failed or timed-out client can leave its container holding the mounted files.
          try {
            await runDocker(["rm", "--force", name], { encoding: "utf8" });
          } catch (cleanupError) {
            if (!(
              cleanupError instanceof Error && cleanupError.message.includes("No such container:")
            )) {
              throw new AggregateError(
                [error, cleanupError],
                "Native workspace initialization and cleanup failed.",
                { cause: cleanupError },
              );
            }
          }
          throw error;
        }
      };

      // Join both containers before the mounted directories can be removed.
      const attempts = await Promise.allSettled([
        execute(execution.stdin),
        execute(execution.stdin),
      ]);
      const errors: unknown[] = [];
      for (const attempt of attempts) {
        if (attempt.status === "rejected") {
          const reason: unknown = attempt.reason;
          errors.push(reason);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Concurrent native workspace initialization failed.");
      }
      assert.equal(await readFile(join(workspace, "AGENTS.md"), "utf8"), setup.files["AGENTS.md"]);
      const record: unknown = JSON.parse(
        await readFile(join(workspace, ".oce-workspace-setup.json"), "utf8"),
      );
      assert.equal(asRecord(record)?.id, setup.id);
      await writeFile(join(workspace, "AGENTS.md"), "User edit after initialization\n");
      await execute(execution.stdin);
      assert.equal(
        await readFile(join(workspace, "AGENTS.md"), "utf8"),
        "User edit after initialization\n",
      );
      const { files: _files, ...completed } = setup;
      await execute(JSON.stringify({ ...completed, completed: true }));
    },
  );
}
