import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  Configuration,
  ConfigurationDriver,
  ConfigurationReference,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import { validateModelCredentialReferences } from "../model-auth.ts";
import { immutableCopy } from "@openclaw-enterprise/utils";

const ID = /^(?:ns|cfg)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pathFor(root: string, reference: ConfigurationReference): string {
  for (const [value, prefix] of [
    [reference.namespaceId, "ns"],
    [reference.id, "cfg"],
  ]) {
    if (typeof value !== "string" || !value.startsWith(`${prefix}_`) || !ID.test(value)) {
      throw new Error(`Configuration ${prefix} ID must be a server-generated ${prefix}_ ID.`);
    }
  }
  return join(root, reference.namespaceId, `${reference.id}.json`);
}

export class FilesystemConfigurationDriver implements ConfigurationDriver {
  readonly id = "configuration-filesystem-development";
  readonly capability = "configuration" as const;
  readonly implementation = "filesystem-local";
  private readonly root: string;

  constructor(root: string) {
    if (typeof root !== "string" || root.trim().length === 0) {
      throw new Error(
        "OCC_DEVELOPMENT_CONFIGURATION_ROOT is required for filesystem development configurations.",
      );
    }
    this.root = resolve(root);
  }

  async validateValues(values: OpenClawConfigurationDocument): Promise<void> {
    validateModelCredentialReferences(values);
  }

  async validate(configuration: Configuration): Promise<void> {
    pathFor(this.root, configuration);
    await this.validateValues(configuration.values);
  }

  async create(configuration: Configuration): Promise<Configuration> {
    await this.write(configuration);
    return immutableCopy(configuration) as Configuration;
  }

  async read(reference: ConfigurationReference): Promise<Configuration> {
    const configuration: unknown = JSON.parse(
      await readFile(pathFor(this.root, reference), "utf8"),
    );
    if (
      typeof configuration !== "object" ||
      configuration === null ||
      Array.isArray(configuration) ||
      !("id" in configuration) ||
      configuration.id !== reference.id ||
      !("namespaceId" in configuration) ||
      configuration.namespaceId !== reference.namespaceId
    ) {
      throw new Error("Stored Configuration does not belong to the exact requested Namespace.");
    }
    await this.validate(configuration as Configuration);
    return immutableCopy(configuration as Configuration) as Configuration;
  }

  async update(configuration: Configuration): Promise<Configuration> {
    await this.read(configuration);
    return this.create(configuration);
  }

  async delete(reference: ConfigurationReference): Promise<void> {
    await this.read(reference);
    await rm(pathFor(this.root, reference));
  }

  private async write(configuration: Configuration): Promise<void> {
    await this.validate(configuration);
    const path = pathFor(this.root, configuration);
    const directory = join(this.root, configuration.namespaceId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${configuration.id}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(configuration)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }
}

export function createFilesystemDevelopmentConfigurationDriverFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): FilesystemConfigurationDriver {
  return new FilesystemConfigurationDriver(environment.OCC_DEVELOPMENT_CONFIGURATION_ROOT ?? "");
}
