import { setTimeout as delay } from "node:timers/promises";
import type { ClientCommand } from "../repository-credentials/clients.ts";
import { run as runCommand } from "../repository-credentials/process.mjs";

const run = runCommand as ClientCommand;

type DockerNetworkCommand = (args: string[]) => Promise<{ stdout: string }>;
type DockerNetworkListEntry = { Name: string; ID: string };
type DockerNetworkDetails = { Name: string; Id: string; Labels?: Record<string, string> };

export function forwardWork(signal: AbortSignal) {
  const controller = new AbortController();
  const pending = new Set<ReturnType<ClientCommand>>();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    cancel();
  }
  const check = () => controller.signal.throwIfAborted();
  return {
    check,
    async command(command: string, args: string[], options?: Parameters<ClientCommand>[2]) {
      check();
      const operation = run(command, args, { ...options, signal: controller.signal });
      pending.add(operation);
      try {
        const result = await operation;
        check();
        return result;
      } finally {
        pending.delete(operation);
      }
    },
    async eventually<T>(checkState: () => T | Promise<T>, timeout = 10000) {
      const deadline = Date.now() + timeout;
      // The deadline is checked after each read, so the last read happens at or past it.
      for (;;) {
        check();
        const value = await checkState();
        check();
        if (value) {
          return value;
        }
        if (Date.now() >= deadline) {
          break;
        }
        await delay(100, undefined, { signal: controller.signal });
      }
      throw new Error("isolation fixture did not reach expected state");
    },
    async stop() {
      cancel();
      signal.removeEventListener("abort", cancel);
      await Promise.allSettled([...pending]);
    },
  };
}

export function ownedNetwork(name: string, owner: string, docker: DockerNetworkCommand) {
  let attempted = false;
  let uncertain = false;
  const label = "repository-credentials-isolation.owner";
  return {
    async create() {
      // Register before dispatch: a lost CLI response does not undo daemon work.
      attempted = true;
      uncertain = true;
      await docker(["network", "create", "--internal", "--label", `${label}=${owner}`, name]);
      uncertain = false;
    },
    async remove(cleanupDocker: DockerNetworkCommand, signal = AbortSignal.timeout(60000)) {
      if (!attempted) {
        return;
      }
      // Empty readbacks cannot settle a create whose response was lost: the
      // daemon may still complete it. Observe and remove that owned resource,
      // or report unresolved cleanup when the independent budget expires.
      for (;;) {
        signal.throwIfAborted();
        const result = await cleanupDocker([
          "network",
          "ls",
          "--no-trunc",
          "--format",
          "{{json .}}",
          "--filter",
          `name=${name}`,
        ]);
        const networks = result.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as DockerNetworkListEntry)
          .filter((network) => network.Name === name);
        signal.throwIfAborted();
        if (!networks.length && !uncertain) {
          return;
        }
        for (const network of networks) {
          const [details] = JSON.parse(
            (await cleanupDocker(["network", "inspect", network.ID])).stdout,
          ) as DockerNetworkDetails[];
          if (
            details?.Name !== name ||
            details.Labels?.[label] !== owner ||
            details.Id !== network.ID
          ) {
            throw new Error("owned network identity mismatch");
          }
          await cleanupDocker(["network", "rm", details.Id]);
          uncertain = false;
        }
        await delay(100, undefined, { signal });
      }
    },
  };
}
