// The API process: startApi (api-startup.mjs) with this process's environment. A startup
// failure ends the process with one structured log line naming its code.
import { startApi, startupFailureFields } from "./api-startup.mjs";
import { createOccLogger, emitOccLogEvent } from "./logging.ts";

try {
  await startApi(process.env);
} catch (error) {
  emitOccLogEvent(createOccLogger({ component: "occ-api", level: "info", destination: "stderr" }), {
    event: "startup-error",
    ...startupFailureFields(error),
  });
  process.exitCode = 1;
}
