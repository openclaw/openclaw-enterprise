import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  createProvisioningInputProtector,
  parseProvisioningInputKeyring,
  type ProvisioningInputProtector,
} from "@openclaw-enterprise/occ";

export const OCC_PROVISIONING_KEYS_PATH = "OCC_PROVISIONING_KEYS_PATH";

export interface ProvisioningInputProtectorOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export async function loadProvisioningInputProtector(
  options: ProvisioningInputProtectorOptions = {},
): Promise<ProvisioningInputProtector | undefined> {
  const environment = options.environment ?? process.env;
  const keyringPath = environment[OCC_PROVISIONING_KEYS_PATH];
  if (keyringPath === undefined) {
    return undefined;
  }
  if (keyringPath.trim().length === 0 || !isAbsolute(keyringPath)) {
    throw new Error(`${OCC_PROVISIONING_KEYS_PATH} must identify an absolute mounted-file path.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(keyringPath, "utf8"));
  } catch {
    throw new Error("The configured provisioning input keyring is unavailable or invalid.");
  }
  return createProvisioningInputProtector(parseProvisioningInputKeyring(parsed));
}
