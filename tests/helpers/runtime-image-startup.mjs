// Shared by the runtime image startup smoke tests, which CI runs in three lanes
// (runtime-image-startup.test.ts, runtime-image-startup-probe.test.mjs,
// runtime-image-startup-termination.test.ts,
// runtime-image-gateway-unclean-restart.test.ts,
// runtime-image-gateway-retained-state.test.ts,
// runtime-image-gateway-peer.test.ts, runtime-image-native-worker.test.ts,
// runtime-image-state-migration.test.ts,
// runtime-image-managed-files.test.ts,
// runtime-image-native-listener.test.ts and
// runtime-image-gateway-workspace.test.ts).
import { randomBytes } from "node:crypto";
import { runDocker } from "./runtime-image-docker.ts";
import { image } from "./runtime-image-startup.ts";

export {
  commandOutput,
  docker,
  execute,
  failureTail,
  runDocker,
  runDockerCommand,
  waitForDockerLog,
} from "./runtime-image-docker.ts";
export {
  containerLogTail,
  gatewayReadinessReport,
  jsonLogEntries,
  listGatewayPlugins,
  openClawGatewaySpawnedRequest,
  openClawProcessRunningRequest,
  waitForContainerReady,
  waitForGatewayReady,
  waitForGatewaySpawn,
} from "./runtime-image-gateway-observations.ts";
export {
  assertGatewayFirstTurnMemory,
  gatewayFirstTurnMemoryBudgetBytes,
  gatewayMemoryArguments,
  gatewayMemoryPeak,
} from "./runtime-image-memory.ts";

export {
  assertGatewayLogEntry,
  createAdmittedRuntimeImageConfiguration,
  createRuntimeImageConfiguration,
  image,
  imageTestOptions,
  reviewedCodexSeccompSecurityOptions,
  runGatewaySmoke,
  runtimeImageModel,
  temporaryGatewayConfiguration,
} from "./runtime-image-startup.ts";

// A new volume owned by the Gateway user, for mounting at `mountPath` (the
// Gateway home or its ~/.openclaw) as its PersistentVolume is. `seed`, a shell
// command run first as root with `seedVolumes` also mounted, can fill it.
/**
 * @param {{after(cleanup: () => unknown): void}} t
 * @param {string} mountPath
 * @param {{seed?: string, seedVolumes?: string[]}} [options]
 */
export async function gatewayStateVolume(t, mountPath, { seed, seedVolumes = [] } = {}) {
  const volume = `oce-runtime-image-state-${randomBytes(6).toString("hex")}`;
  await runDocker(["volume", "create", volume]);
  // node:test runs `after` hooks in registration order, so this one runs before
  // the hooks that remove the containers started on the volume later, and Docker
  // refuses to remove a volume in use. Remove those containers first.
  t.after(async () => {
    const users = await runDocker(["ps", "-aq", "--filter", `volume=${volume}`]).catch(
      () => undefined,
    );
    const ids = users?.stdout.split(/\s+/).filter(Boolean) ?? [];
    if (ids.length > 0) {
      await runDocker(["rm", "-f", ...ids]).catch(() => {});
    }
    await runDocker(["volume", "rm", "-f", volume]).catch(() => {});
  });
  // As root, like the Docker Driver's workspace setup: a new volume mounted
  // below the image's home can be root-owned.
  await runDocker([
    "run",
    "--rm",
    "--user",
    "0:0",
    "--network",
    "none",
    "--volume",
    `${volume}:${mountPath}`,
    ...seedVolumes.flatMap((value) => ["--volume", value]),
    "--entrypoint",
    "sh",
    image,
    "-c",
    `${seed === undefined ? "" : `${seed} && `}chown -R 1000:1000 ${mountPath}`,
  ]);
  return volume;
}
