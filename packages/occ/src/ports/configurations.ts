import type { SecretBindings } from "@openclaw-enterprise/contracts";

export interface ConfigurationOwnership {
  readonly id: string;
  readonly namespaceId: string;
  readonly kind: "agent";
  readonly generation: number;
  readonly secretBindings?: SecretBindings;
  readonly createdAt: string;
}

export interface ConfigurationReadRepository {
  findConfiguration(
    namespaceId: string,
    configurationId: string,
  ): Promise<Readonly<ConfigurationOwnership> | undefined>;
}

export interface ConfigurationRepository extends ConfigurationReadRepository {
  createConfiguration(
    configuration: ConfigurationOwnership,
  ): Promise<Readonly<ConfigurationOwnership>>;
  lockConfiguration(
    namespaceId: string,
    configurationId: string,
  ): Promise<Readonly<ConfigurationOwnership> | undefined>;
  advanceConfigurationGeneration(
    namespaceId: string,
    configurationId: string,
    expectedGeneration: number,
    secretBindings?: SecretBindings,
  ): Promise<Readonly<ConfigurationOwnership> | undefined>;
  deleteConfiguration(namespaceId: string, configurationId: string): Promise<boolean>;
}
