import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Secret } from "../../packages/contracts/src/index.ts";
import { AwsSecretsManagerSecretDriver } from "../../apps/controller/src/drivers/secret/aws-secrets-manager/index.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";

export const options = { region: "us-east-1", accountId: "123456789012", prefix: "oce/test" };
export type RecordValue = {
  ARN: string;
  Name: string;
  Tags: { Key: string; Value: string }[];
  VersionIdsToStages: Record<string, string[]>;
  DeletedDate?: Date;
};

// Only the AWS service is simulated: commands, Driver, Installation validation,
// OCC lifecycle, ownership checks, and IAM decisions use production code.
export function backend(configuration = options, selection: { id?: string } = {}) {
  const records = new Map<string, RecordValue>();
  const values = new Map<string, string>();
  const calls: string[] = [];
  type CommandInput = {
    Name?: string;
    SecretId?: string;
    SecretString?: string;
    ClientRequestToken?: string;
    VersionId?: string;
    VersionStage?: string;
    Tags?: RecordValue["Tags"];
    RecoveryWindowInDays?: number;
    ForceDeleteWithoutRecovery?: boolean;
  };
  let fault: ((name: string, input: CommandInput) => unknown) | undefined;
  const send = async (command: { constructor: { name: string }; input: CommandInput }) => {
    const kind = command.constructor.name;
    calls.push(kind);
    const overridden = fault?.(kind, command.input);
    if (overridden !== undefined) {
      return overridden;
    }
    const input = command.input;
    if (kind === "CreateSecretCommand") {
      const ARN = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${input.Name}-Ab123x`;
      if (records.has(ARN)) {
        throw new Error("ResourceExistsException");
      }
      records.set(ARN, {
        ARN,
        Name: input.Name!,
        Tags: command.input.Tags!,
        VersionIdsToStages: { [input.ClientRequestToken!]: ["AWSCURRENT"] },
      });
      values.set(input.ClientRequestToken!, input.SecretString!);
      return { ARN, Name: input.Name, VersionId: input.ClientRequestToken };
    }
    const record = records.get(input.SecretId!);
    if (!record) {
      throw new Error("ResourceNotFoundException: synthetic sensitive diagnostic");
    }
    if (kind === "DescribeSecretCommand") {
      return structuredClone(record);
    }
    if (kind === "GetSecretValueCommand") {
      assert.equal(input.VersionStage, "AWSCURRENT");
      if (!record.VersionIdsToStages[input.VersionId!]?.includes("AWSCURRENT")) {
        throw new Error("InvalidRequestException");
      }
      return {
        ARN: record.ARN,
        Name: record.Name,
        VersionId: input.VersionId,
        VersionStages: ["AWSCURRENT"],
        SecretString: values.get(input.VersionId!),
      };
    }
    if (kind === "PutSecretValueCommand") {
      for (const key of Object.keys(record.VersionIdsToStages)) {
        record.VersionIdsToStages[key] = ["AWSPREVIOUS"];
      }
      record.VersionIdsToStages[input.ClientRequestToken!] = ["AWSCURRENT"];
      values.set(input.ClientRequestToken!, input.SecretString!);
      return {
        ARN: record.ARN,
        Name: record.Name,
        VersionId: input.ClientRequestToken,
        VersionStages: ["AWSCURRENT"],
      };
    }
    assert.equal(kind, "DeleteSecretCommand");
    assert.equal(command.input.RecoveryWindowInDays, 30);
    assert.equal(command.input.ForceDeleteWithoutRecovery, undefined);
    record.DeletedDate = new Date();
    return { ARN: record.ARN, Name: record.Name, DeletionDate: record.DeletedDate };
  };
  const client = { send } as unknown as NonNullable<
    ConstructorParameters<typeof AwsSecretsManagerSecretDriver>[1]
  >["client"];
  const identityClient = { send: async () => ({ Account: options.accountId }) };
  const credentials = { accessKeyId: "synthetic-key", secretAccessKey: "synthetic-signing-key" };
  const injection = { client: client!, identityClient, credentials };
  const driver = new AwsSecretsManagerSecretDriver(configuration, { ...selection, ...injection });
  return {
    records,
    values,
    calls,
    client: client!,
    injection,
    driver,
    setFault(value: typeof fault) {
      fault = value;
    },
  };
}

export async function awsFixtureFromInstallation(t: TestContext) {
  const configuration = createInstallationDriverConfiguration();
  const config = {
    ...configuration,
    drivers: {
      ...configuration.drivers,
      secret: { id: "secret-aws-secrets-manager", configuration: options },
    },
  };
  const runtime = await loadInstallationFile(t, config);
  assert.ok(runtime?.secretDriver instanceof AwsSecretsManagerSecretDriver);
  assert.equal(runtime.installation.drivers.secret.definition, AwsSecretsManagerSecretDriver);
  const { configuration: selectedOptions, id } = runtime.installation.drivers.secret;
  return { config, ...backend(selectedOptions as unknown as typeof options, { id }) };
}

export async function stored(b: ReturnType<typeof backend>): Promise<Secret> {
  const identity = {
    id: `sec_${randomUUID()}`,
    namespaceId: `ns_${randomUUID()}`,
    name: "api-key",
  };
  return {
    ...identity,
    driverId: b.driver.id,
    createdAt: new Date().toISOString(),
    backendRef: await b.driver.create(identity, "synthetic-original"),
  };
}
