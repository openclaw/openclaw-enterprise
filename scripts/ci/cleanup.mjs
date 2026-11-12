#!/usr/bin/env node
import { main } from "./cleanup.ts";

export {
  cleanupResourceIds,
  cleanupState,
  deleteOwnedK3dCluster,
  stopCleanupCommands,
} from "./cleanup.ts";

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
