import { unlink } from "node:fs/promises";

import { closeResources } from "../composition/close-resources.ts";

interface Closable {
  close(): Promise<void>;
}

/** The worker composition that `worker.mjs` closes on SIGTERM or SIGINT. */
export interface WorkerComposition {
  /** The readiness marker the worker loop's health checks write. */
  readonly readinessPath?: string;
  readonly repositoryGitTransport?: Closable;
  readonly preparedRepositoryGit?: Closable;
  readonly receiptServer?: Closable;
  readonly closeMetrics: () => Promise<void>;
  readonly preparedGitHub?: Closable;
  readonly worker: { stopLoop(): Promise<void>; stop(): Promise<void> };
}

/**
 * Close the worker composition in dependency order, preserving the first failure. Every step
 * runs after an earlier one fails: a receipt listener left open kept the worker process alive
 * until SIGKILL (finding 2989). The worker loop stops first, so no health check rewrites the
 * readiness marker after its removal and no pass claims work after the parts it uses close;
 * the worker's database pool closes last (finding 2997).
 */
export function closeWorkerComposition(composition: WorkerComposition): Promise<void> {
  const { readinessPath } = composition;
  return closeResources(
    { close: () => composition.worker.stopLoop() },
    readinessPath === undefined
      ? undefined
      : { close: () => unlink(readinessPath).catch(() => {}) },
    composition.repositoryGitTransport,
    composition.preparedRepositoryGit,
    composition.receiptServer,
    { close: composition.closeMetrics },
    composition.preparedGitHub,
    { close: () => composition.worker.stop() },
  );
}
