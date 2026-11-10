import {
  ConfigurationValidationError,
  requireConfiguration,
  validateSandboxNetworkGrants,
} from "../packages/contracts/src/index.ts";
import {
  configurationSchema,
  validateConfiguration,
} from "../apps/controller/src/drivers/sandbox/openshell.ts";

try {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const configuration = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (process.argv[2] === "--ceiling") {
    validateSandboxNetworkGrants(configuration, "/grants");
  } else {
    requireConfiguration({ configurationSchema, validateConfiguration }, configuration);
  }
} catch (error) {
  process.stderr.write(
    error instanceof ConfigurationValidationError
      ? `${JSON.stringify(error.error)}\n`
      : "Sandbox network policy validation failed.\n",
  );
  process.exitCode = 1;
}
