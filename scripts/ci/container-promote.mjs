import { pathToFileURL } from "node:url";
import { main } from "./container-promote.ts";

export {
  hubRepositoryPath,
  validateHubRepository,
  validatePublicationRun,
  validateReceipt,
} from "./container-promote.ts";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
