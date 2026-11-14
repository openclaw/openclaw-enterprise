import { execFile, spawn, type ExecFileOptions, type SpawnOptions } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { withoutShellStartup } from "./environment.ts";

export const helmTargetOverrides = [
  "HELM_KUBEAPISERVER",
  "HELM_KUBECAFILE",
  "HELM_KUBETLS_SERVER_NAME",
  "HELM_KUBEINSECURE_SKIP_TLS_VERIFY",
];
export const readyCapability = { status: 200, body: '{"durableAdmissionVersion":1}' };
export const controller = `registry.example.invalid/controller@sha256:${"a".repeat(64)}`;
export const runtime = `registry.example.invalid/runtime@sha256:${"b".repeat(64)}`;
export const newController = `registry.example.invalid/controller@sha256:${"e".repeat(64)}`;
export const newBroker = `registry.example.invalid/broker@sha256:${"f".repeat(64)}`;
export const oldRuntime = `registry.example.invalid/runtime@sha256:${"c".repeat(64)}`;

// The fixture exits 9 only for an armed fault. An interrupted run must reach that fault.
export const injectedFault = { code: 9 };

const executeFile = promisify(execFile);

export function execute(
  command: string,
  args: readonly string[],
  options: Omit<ExecFileOptions, "encoding"> = {},
) {
  // Return the original promise so the fixture can signal its running child.
  return executeFile(command, args, {
    ...options,
    encoding: "utf8",
    env: withoutShellStartup(options.env ?? process.env),
  });
}

async function commandPath(name: "helm" | "sleep" | "setsid", fallback: string) {
  const { stdout } = await execute("bash", [
    "--noprofile",
    "--norc",
    "-c",
    `command -v ${name}`,
  ]).catch(() => ({ stdout: "" }));
  return stdout.trim() || fallback;
}

export async function createRecoveryTools(repository: string) {
  const sourceRevision = (
    await execute("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: repository })
  ).stdout.trim();
  const script =
    process.env.OCC_UPGRADE_SCRIPT ?? join(repository, "scripts/upgrade-production-images");
  // Stock-chart cases render with the real Helm binary even when the upgrade calls the shim.
  const realHelm = await commandPath("helm", "");
  const shimTools = {
    bash: "/bin/bash",
    sleep: await commandPath("sleep", "/bin/sleep"),
    setsid: await commandPath("setsid", "/usr/bin/setsid"),
  };
  return { repository, sourceRevision, script, realHelm, shimTools };
}

export type RecoveryTools = Awaited<ReturnType<typeof createRecoveryTools>>;

type ProcessResult = { status: number | null; stdout: string; stderr: string };

// Wait for the exit status and drained output without blocking other cases' commands.
export function spawnResult(
  command: string,
  args: readonly string[],
  options: Omit<SpawnOptions, "stdio">,
  stderrFd: number | "pipe" = "pipe",
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      env: withoutShellStartup(options.env ?? process.env),
      stdio: ["ignore", "pipe", stderrFd],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ status: null, stdout, stderr: stderr + error.message }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
