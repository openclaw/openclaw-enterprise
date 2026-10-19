import { validateSandboxNetworkGrants } from "../packages/contracts/src/index.ts";
import { createRequire } from "node:module";
import {
  configurationSchema,
  validateConfiguration,
} from "../apps/controller/src/drivers/sandbox/openshell.ts";

const { Check } = createRequire(new URL("../apps/controller/package.json", import.meta.url))(
  "typebox/value",
);

try {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const configuration = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (process.argv[2] === "--ceiling") {
    validateSandboxNetworkGrants(configuration);
  } else {
    if (!Check(configurationSchema, configuration)) {
      throw new Error("The policy does not match the OpenShell Driver configuration schema.");
    }
    validateConfiguration(configuration);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
