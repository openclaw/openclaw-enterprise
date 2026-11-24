import { readFile } from "node:fs/promises";

import { asRecord } from "../../packages/utils/src/objects.ts";

type TwoClusterInputs = Readonly<{
  configuration: Readonly<Record<string, unknown>>;
  origin: URL;
  authMethod: "api_key" | "codex_pat";
  modelEnvironment: "OPENAI_API_KEY" | "CODEX_ACCESS_TOKEN";
  modelCredential: string;
}>;

export async function readTwoClusterInputs(
  configurationFile: string,
  environment: NodeJS.ProcessEnv,
): Promise<TwoClusterInputs> {
  const input = await readFile(configurationFile, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("The two-cluster fixture must be a JSON object.");
  }
  const configuration = asRecord(value);
  if (!configuration) {
    throw new Error("The two-cluster fixture must be a JSON object.");
  }

  const origin = typeof configuration.apiUrl === "string" ? URL.parse(configuration.apiUrl) : null;
  if (!origin) {
    throw new Error("The two-cluster fixture requires a valid apiUrl.");
  }
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
    !["http:", "https:"].includes(origin.protocol)
  ) {
    throw new Error("The two-cluster fixture apiUrl must use HTTP or HTTPS on loopback.");
  }
  // The serialized URL preserves a bare query or fragment delimiter.
  if (
    origin.username ||
    origin.password ||
    origin.href.includes("?") ||
    origin.href.includes("#")
  ) {
    throw new Error(
      "The two-cluster fixture apiUrl cannot contain credentials, a query or a fragment.",
    );
  }

  const authMethod = configuration.harnessAuthMethod ?? "api_key";
  if (authMethod !== "api_key" && authMethod !== "codex_pat") {
    throw new Error("Unsupported harnessAuthMethod.");
  }
  const modelEnvironment = authMethod === "codex_pat" ? "CODEX_ACCESS_TOKEN" : "OPENAI_API_KEY";
  const modelCredential = environment[modelEnvironment];
  if (!modelCredential) {
    throw new Error(`The selected real-runtime case requires ${modelEnvironment}.`);
  }

  return { configuration, origin, authMethod, modelEnvironment, modelCredential };
}
