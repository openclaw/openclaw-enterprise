import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

type CommandResult = { stdout: string; stderr: string };
type StreamedCommand = ChildProcessByStdio<null, Readable, Readable>;

export type K3dCommand = (
  command: string,
  args: string[],
  options?: {
    timeoutMs: number;
    processGroup?: boolean;
    streamStdout?: boolean;
    input?: Readable;
    onSpawn?: (child: StreamedCommand) => void;
  },
) => Promise<CommandResult>;

export type PreparationTiming = <Result>(
  lane: string,
  phase: string,
  operation: () => Promise<Result>,
) => Promise<Result>;

interface NodeImageDependencies {
  execFile: K3dCommand;
  boundedImageCommand: (args: string[], what: string, shown: string[]) => Promise<CommandResult>;
  immutableDigest: (reference: string) => string | undefined;
  progress: (lane: string, message: string) => void;
  timedPreparation: PreparationTiming;
}

interface NodeImageCluster {
  nodes: readonly string[];
}

interface CriImageInspection {
  status?: { repoDigests?: unknown; pinned?: unknown };
}

// containerd's CRI plugin answers `crictl inspecti` only from its in-memory image
// cache, which its serial event monitor fills from containerd ImageCreate events.
// A reference that `ctr images tag` just created is in containerd's image store
// (and `ctr images list`) before that event is handled, so CRI can briefly report
// "no such image" or an image whose pin label event has not arrived. Wait a bounded
// time for those states; a mismatched digest or any other failure is final.
const criImageCacheWaitMs = 5_000;

// A Ready node's containerd can still refuse connections: a worker import once
// failed with "connect: connection refused" 6 s after every node was Ready
// (finding 1006). Probe each node's containerd before streaming an image to it.
// A probe that hangs is final; any other failure is retried until the deadline.
const k3dContainerdWaitMs =
  Number(process.env.OPENCLAW_CI_K3D_CONTAINERD_WAIT_MS) > 0
    ? Number(process.env.OPENCLAW_CI_K3D_CONTAINERD_WAIT_MS)
    : 60_000;

const containerdSocketUnavailable =
  /\/run\/k3s\/containerd\/containerd\.sock: connect: (?:connection refused|no such file or directory)/;

export function createK3dNodeImages({
  execFile,
  boundedImageCommand,
  immutableDigest,
  progress,
  timedPreparation,
}: NodeImageDependencies) {
  // Each check or tag on a node after the import is one short exec. The timeout stops the
  // engine CLI; a process it started inside the node may keep running until the cluster is
  // removed.
  async function k3dNodeImageCheck(node: string, args: string[], what: string) {
    return boundedImageCommand(["exec", node, ...args], `${what} on ${node}`, args);
  }

  async function inspectK3dCriImage(
    lane: string,
    node: string,
    reference: string,
    envName: string,
  ) {
    const deadline = performance.now() + criImageCacheWaitMs;
    for (let attempt = 1; ; attempt += 1) {
      let result: CommandResult;
      try {
        result = await k3dNodeImageCheck(node, ["crictl", "inspecti", reference], "CRI");
      } catch (error) {
        const remainingMs = deadline - performance.now();
        const { stderr } = error as { stderr?: string };
        if (!/\bno such image\b/i.test(stderr ?? "") || remainingMs <= 0) {
          throw error;
        }
        progress(
          lane,
          `CRI on ${node} does not list the imported ${envName} reference yet (attempt ${attempt}); retrying.`,
        );
        await delay(Math.min(250 * attempt, 1_000, remainingMs));
        continue;
      }
      const { status } = JSON.parse(result.stdout) as CriImageInspection;
      if (
        !Array.isArray(status?.repoDigests) ||
        !status.repoDigests.every((digest) => typeof digest === "string") ||
        !status.repoDigests.includes(reference)
      ) {
        throw new Error(`CRI on ${node} does not match the imported ${envName} digest.`);
      }
      if (status.pinned !== undefined && typeof status.pinned !== "boolean") {
        throw new Error(`CRI on ${node} reported a malformed ${envName} image pin.`);
      }
      if (status.pinned === true) {
        return;
      }
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        throw new Error(`CRI on ${node} did not report the imported ${envName} image pinned.`);
      }
      progress(lane, `CRI on ${node} has not pinned the imported ${envName} image yet; retrying.`);
      await delay(Math.min(250 * attempt, 1_000, remainingMs));
    }
  }

  async function assertK3dImageReference(
    lane: string,
    cluster: NodeImageCluster,
    reference: string,
    envName: string,
  ) {
    for (const node of cluster.nodes) {
      const listed = await k3dNodeImageCheck(
        node,
        ["ctr", "-n", "k8s.io", "images", "list"],
        "containerd",
      );
      const found = listed.stdout
        .split(/\r?\n/)
        .find((entry) => entry.split(/\s+/)[0] === reference);
      if (!found) {
        throw new Error(`Unable to find imported ${envName} reference ${reference}.`);
      }
      if (found.split(/\s+/)[2] !== `sha256:${immutableDigest(reference)}`) {
        throw new Error(`containerd on ${node} does not match the imported ${envName} digest.`);
      }
      await inspectK3dCriImage(lane, node, reference, envName);
    }
  }

  async function waitForK3dContainerd(lane: string, cluster: NodeImageCluster) {
    // The first failed node stops polling; drain already-started probes before returning.
    let failed = false;
    const probes = cluster.nodes.map(async (node) => {
      const deadline = performance.now() + k3dContainerdWaitMs;
      for (let attempt = 1; !failed; attempt += 1) {
        try {
          await k3dNodeImageCheck(node, ["ctr", "-n", "k8s.io", "version"], "containerd");
          return;
        } catch (error) {
          const remainingMs = deadline - performance.now();
          const { cause, message } = error as Error & { cause?: { timedOut?: boolean } };
          if (cause?.timedOut === true || remainingMs <= 0) {
            failed = true;
            throw cause?.timedOut === true
              ? error
              : new Error(
                  `containerd on ${node} did not answer within ${k3dContainerdWaitMs} ms: ${message}`,
                  { cause: error },
                );
          }
          if (failed) {
            return;
          }
          progress(
            lane,
            `containerd on ${node} is not answering yet (attempt ${attempt}); retrying.`,
          );
          await delay(Math.min(250 * attempt, 2_000, remainingMs));
        }
      }
    });
    try {
      await Promise.all(probes);
    } catch (error) {
      await Promise.allSettled(probes);
      throw error;
    }
  }

  // k3d tools-node mode can exit successfully after a per-node import failure, so
  // stream the export into each owned node's containerd directly and propagate
  // both export and node-local containerd errors. A containerd that stops
  // answering during the import gets one more wait and import; ctr import is
  // idempotent, so nodes that already imported the image are unaffected.
  async function importImageIntoK3dNodes(
    lane: string,
    cluster: NodeImageCluster,
    saveArgs: string[],
  ) {
    for (let attempt = 1; ; attempt += 1) {
      await waitForK3dContainerd(lane, cluster);
      try {
        return await timedPreparation(lane, "image-stream-import", () =>
          streamImageIntoK3dNodes(cluster, saveArgs),
        );
      } catch (error) {
        const { stderr } = error as { stderr?: string };
        if (attempt > 1 || !containerdSocketUnavailable.test(stderr ?? "")) {
          throw error;
        }
        progress(
          lane,
          "A node's containerd refused the image import; waiting for it to retry once.",
        );
      }
    }
  }

  // Stream one image export into every owned node's containerd at once. No
  // archive touches the host or node disks. The export and every node import
  // must exit 0; the caller then verifies the imported reference on each node.
  async function streamImageIntoK3dNodes(cluster: NodeImageCluster, saveArgs: string[]) {
    const containerEngine = process.env.OCC_DOCKER_BIN ?? "docker";
    // The executor calls onSpawn synchronously with the streamed child.
    let save!: StreamedCommand;
    const saved = execFile(containerEngine, saveArgs, {
      timeoutMs: 600_000,
      streamStdout: true,
      onSpawn: (child) => {
        save = child;
      },
    });
    // Settled below, after the imports; never let an early failure go unhandled.
    saved.catch(() => {});
    let stoppedExport = false;
    let firstImportError: unknown;
    const imports = cluster.nodes.map((node) =>
      execFile(
        containerEngine,
        [
          "exec",
          "-i",
          node,
          "ctr",
          "-n",
          "k8s.io",
          "images",
          "import",
          "--all-platforms",
          "--label",
          "io.cri-containerd.pinned=pinned",
          "-",
        ],
        { timeoutMs: 600_000, input: save.stdout },
      ).catch((error: unknown) => {
        // The first node failure is the cause; later ones may follow from it.
        firstImportError ??= error;
        // A failed node stops reading. Stop a still-running export so it cannot
        // block on a full pipe until its timeout. Once the export's output has
        // ended, no node can have stopped it, so the export's own exit decides
        // whether it failed, even if that exit is not seen yet: a node that reads
        // a truncated stream to its end can report its failure first.
        if (!save.stdout.readableEnded && save.exitCode === null && save.signalCode === null) {
          stoppedExport = true;
          save.kill("SIGTERM");
        }
        throw error;
      }),
    );
    await Promise.allSettled(imports);
    // An importer may stop before the archive's trailing padding; discard the
    // rest so the export can exit instead of blocking on a full pipe.
    save.stdout.resume();
    const [exported] = await Promise.allSettled([saved]);
    // An export failure truncates every import stream, so report it first unless
    // a node failure is what stopped the export.
    if (exported.status === "rejected" && !stoppedExport) {
      throw exported.reason;
    }
    if (firstImportError) {
      throw firstImportError;
    }
    if (exported.status === "rejected") {
      throw exported.reason;
    }
  }

  return { k3dNodeImageCheck, assertK3dImageReference, importImageIntoK3dNodes };
}
