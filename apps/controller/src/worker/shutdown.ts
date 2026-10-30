import { closeResources } from "../composition/close-resources.ts";

interface Closable {
  close(): Promise<void>;
}

/** The worker composition that `worker.mjs` closes on SIGTERM or SIGINT. */
export interface WorkerComposition {
  readonly repositoryGitTransport?: Closable;
  readonly preparedRepositoryGit?: Closable;
  readonly receiptServer?: Closable;
  readonly closeMetrics: () => Promise<void>;
  readonly preparedGitHub?: Closable;
  readonly worker: { stop(): Promise<void> };
}

/**
 * Close the worker composition in dependency order, preserving the first failure. Every step
 * runs after an earlier one fails: a receipt listener left open kept the worker process alive
 * until SIGKILL (finding 2989).
 */
export function closeWorkerComposition(composition: WorkerComposition): Promise<void> {
  return closeResources(
    composition.repositoryGitTransport,
    composition.preparedRepositoryGit,
    composition.receiptServer,
    { close: composition.closeMetrics },
    composition.preparedGitHub,
    { close: () => composition.worker.stop() },
  );
}
