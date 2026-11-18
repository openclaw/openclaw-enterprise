import { randomUUID } from "node:crypto";
import { Agent } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
  ResourceNotFoundException,
  type DescribeSecretCommandOutput,
  type SecretsManagerClientConfig,
} from "@aws-sdk/client-secrets-manager";
import {
  requireConfiguration,
  type CredentialInputRead,
  type ErrorDetail,
  type JSONSchema,
  type Secret,
  type SecretBackendRef,
  type SecretDriver,
  type SecretIdentity,
  type VersionedSecretValue,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError, ScopeViolationError } from "@openclaw-enterprise/occ";
import { withComputeOperationDeadline } from "../../compute/operation-context.ts";

import { AwsSecretBinding, type AwsSecretsManagerOptions } from "./binding.ts";
import { awsRequest, sendMutation } from "./request.ts";

export type { AwsSecretsManagerOptions } from "./binding.ts";

/** AWS resource tags must also be protected by the operator's IAM policy. */
export class AwsSecretsManagerSecretDriver implements SecretDriver {
  static readonly configurationSchema: JSONSchema = {
    type: "object",
    additionalProperties: false,
    required: ["region", "accountId", "prefix"],
    properties: {
      region: {
        type: "string",
        pattern: "^(af|ap|ca|eu|il|me|mx|sa|us|cn)-(?!iso[a-z]*-)([a-z]+-)+[0-9]+$",
      },
      accountId: { type: "string", pattern: "^[0-9]{12}$" },
      prefix: { type: "string", pattern: "^[A-Za-z0-9_-][A-Za-z0-9/_-]{0,199}$" },
      kmsKeyId: { type: "string", minLength: 1 },
    },
  };
  static validateConfiguration(
    _configuration: Readonly<AwsSecretsManagerOptions>,
  ): readonly ErrorDetail[] {
    return [];
  }

  readonly capability = "secret" as const;
  readonly implementation = "occ/aws-secrets-manager";
  readonly id: string;
  private readonly ownership: AwsSecretBinding;
  private readonly options: Readonly<AwsSecretsManagerOptions>;
  private readonly client: Pick<SecretsManagerClient, "send">;
  private readonly credentials: SecretsManagerClient["config"]["credentials"];
  private readonly createClients: (
    credentials: Awaited<ReturnType<SecretsManagerClient["config"]["credentials"]>>,
  ) => {
    secrets: Pick<SecretsManagerClient, "send">;
    identity: Pick<STSClient, "send">;
  };

  constructor(
    options: AwsSecretsManagerOptions,
    selection: {
      readonly id?: string;
      readonly client?: Pick<SecretsManagerClient, "send">;
      readonly identityClient?: Pick<STSClient, "send">;
      readonly credentials?: SecretsManagerClientConfig["credentials"];
      readonly requestHandler?: SecretsManagerClientConfig["requestHandler"];
    } = {},
  ) {
    this.options = Object.freeze({
      ...requireConfiguration(AwsSecretsManagerSecretDriver, options),
    });
    this.id = selection.id ?? "secret-aws-secrets-manager";
    this.ownership = new AwsSecretBinding(this.options, this.id);
    // Explicit regional endpoints override environment/shared-config endpoints. The HTTPS
    // agent explicitly verifies certificates even if NODE_TLS_REJECT_UNAUTHORIZED is set.
    const common = {
      region: options.region,
      maxAttempts: 1,
      requestHandler:
        selection.requestHandler ??
        new NodeHttpHandler({
          httpsAgent: new Agent({ rejectUnauthorized: true }),
        }),
      ...(selection.credentials ? { credentials: selection.credentials } : {}),
    };
    const defaults = new SecretsManagerClient({
      ...common,
      endpoint: this.ownership.endpoint("secretsmanager"),
    });
    this.client = selection.client ?? defaults;
    this.credentials = defaults.config.credentials;
    this.createClients = (credentials) => ({
      secrets:
        selection.client ??
        new SecretsManagerClient({
          ...common,
          credentials: { ...credentials },
          endpoint: this.ownership.endpoint("secretsmanager"),
        }),
      identity:
        selection.identityClient ??
        new STSClient({
          ...common,
          credentials: { ...credentials },
          endpoint: this.ownership.endpoint("sts"),
        }),
    });
  }

  private async signingCredentials() {
    return awsRequest(async () => {
      const credentials = { ...(await this.credentials()) };
      if (
        typeof credentials.accessKeyId !== "string" ||
        !credentials.accessKeyId ||
        typeof credentials.secretAccessKey !== "string" ||
        !credentials.secretAccessKey ||
        (credentials.sessionToken !== undefined &&
          (typeof credentials.sessionToken !== "string" || !credentials.sessionToken)) ||
        (credentials.expiration !== undefined && !(credentials.expiration.getTime() > Date.now()))
      ) {
        throw new Error("Invalid AWS signing identity.");
      }
      return Object.freeze(credentials);
    });
  }

  async create(identity: SecretIdentity, value: string): Promise<SecretBackendRef> {
    const namespaceName = this.ownership.namespace(identity);
    this.ownership.validateValue(value);
    const uid = identity.id.slice(4);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uid)) {
      throw new ScopeViolationError("Invalid Secret identity.");
    }
    const name = `${namespaceName}/${identity.id}/${uid}`;
    const token = uid;
    // Resolve once: STS and CreateSecret must sign with the same workload identity,
    // even if its refreshable provider changes accounts between requests.
    const credentials = await this.signingCredentials();
    const clients = this.createClients(credentials);
    const caller = await awsRequest((abortSignal) =>
      clients.identity.send(new GetCallerIdentityCommand({}), { abortSignal }),
    );
    if (caller.Account !== this.options.accountId) {
      throw new ScopeViolationError("AWS caller account does not match Secret configuration.");
    }
    return awsRequest(async (abortSignal, deadline) => {
      const result = await sendMutation(() =>
        clients.secrets.send(
          new CreateSecretCommand({
            Name: name,
            SecretString: value,
            ClientRequestToken: token,
            Tags: this.ownership.tags(identity),
            ...(this.options.kmsKeyId ? { KmsKeyId: this.options.kmsKeyId } : {}),
          }),
          { abortSignal },
        ),
      );
      abortSignal.throwIfAborted();
      this.ownership.checkArn(result.ARN, name);
      if (result.Name !== name || result.VersionId !== token) {
        throw new ScopeViolationError("Secret create response does not match its binding.");
      }
      const suffix = Buffer.from(result.ARN.slice(-6), "ascii").toString("hex");
      const digest = this.ownership.digest(result.ARN);
      const reference = Object.freeze({
        namespaceName: this.ownership.location(identity),
        name: `aws-sm-${suffix}.${digest.slice(0, 32)}.${digest.slice(32)}`,
        uid,
        key: "SecretString",
      });
      await this.verifyCreated(
        identity,
        result.ARN,
        name,
        token,
        clients.secrets,
        abortSignal,
        deadline,
      );
      return reference;
    }, true);
  }

  private async verifyCreated(
    identity: SecretIdentity,
    arn: string,
    name: string,
    token: string,
    client: Pick<SecretsManagerClient, "send">,
    signal: AbortSignal,
    deadline: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      signal.throwIfAborted();
      if (Date.now() >= deadline) {
        throw new DependencyUnavailableError("Secret create verification deadline elapsed.");
      }
      try {
        const result = await client.send(new DescribeSecretCommand({ SecretId: arn }), {
          abortSignal: signal,
        });
        if (result.ARN !== arn || result.Name !== name || result.DeletedDate) {
          throw new ScopeViolationError("Secret create verification identity changed.");
        }
        const expected = this.ownership.tags(identity);
        for (const tag of expected) {
          const actual = result.Tags?.filter((entry) => entry.Key === tag.Key) ?? [];
          if (actual.length > 1 || (actual.length === 1 && actual[0]!.Value !== tag.Value)) {
            throw new ScopeViolationError("Secret create verification ownership changed.");
          }
        }
        const current = Object.entries(result.VersionIdsToStages ?? {}).filter(([, stages]) =>
          stages.includes("AWSCURRENT"),
        );
        if (current.length > 1 || (current.length === 1 && current[0]![0] !== token)) {
          throw new ScopeViolationError("Secret changed during creation.");
        }
        if (
          expected.every((tag) =>
            result.Tags?.some((entry) => entry.Key === tag.Key && entry.Value === tag.Value),
          ) &&
          current.length === 1
        ) {
          return;
        }
      } catch (error) {
        if (!(error instanceof ResourceNotFoundException)) {
          throw error;
        }
      }
      if (attempt < 3) {
        await delay(50 * 2 ** attempt, undefined, { signal });
      }
    }
    throw new DependencyUnavailableError("Secret create verification did not become visible.");
  }

  private async owned(secret: Secret, deleting = false): Promise<DescribeSecretCommandOutput> {
    const { arn, name } = this.ownership.resource(secret);
    const result = await awsRequest((abortSignal) =>
      this.client.send(new DescribeSecretCommand({ SecretId: arn }), { abortSignal }),
    );
    if (
      result.ARN !== arn ||
      result.Name !== name ||
      this.ownership
        .tags(secret)
        .some(
          (tag) =>
            result.Tags?.filter((actual) => actual.Key === tag.Key && actual.Value === tag.Value)
              .length !== 1,
        )
    ) {
      throw new ScopeViolationError("Secret backend ownership changed.");
    }
    if (result.DeletedDate && !deleting) {
      throw new DependencyUnavailableError("Secret is scheduled for deletion.");
    }
    return result;
  }

  private current(result: DescribeSecretCommandOutput): string {
    const versions = Object.entries(result.VersionIdsToStages ?? {}).filter(([, stages]) =>
      stages.includes("AWSCURRENT"),
    );
    if (versions.length !== 1 || !versions[0]![0]) {
      throw new DependencyUnavailableError("Secret has no unique current version.");
    }
    return versions[0]![0];
  }

  async resolve(_secret: Secret): Promise<SecretBackendRef> {
    throw new ScopeViolationError("AWS Secret workload projection is unsupported.");
  }

  async update(secret: Secret, value: string): Promise<void> {
    this.ownership.validateValue(value);
    const observed = await this.owned(secret);
    const current = this.current(observed);
    if (
      Object.entries(observed.VersionIdsToStages ?? {}).some(
        ([version, stages]) => version !== current && stages.includes("AWSPENDING"),
      )
    ) {
      throw new DependencyUnavailableError("Secret rotation is pending.");
    }
    const token = randomUUID();
    const binding = this.ownership.resource(secret);
    const client = this.createClients(await this.signingCredentials()).secrets;
    await awsRequest(async (abortSignal) => {
      const result = await sendMutation(() =>
        client.send(
          new PutSecretValueCommand({
            SecretId: binding.arn,
            SecretString: value,
            ClientRequestToken: token,
            VersionStages: ["AWSCURRENT"],
          }),
          { abortSignal },
        ),
      );
      if (
        result.ARN !== binding.arn ||
        result.Name !== binding.name ||
        result.VersionId !== token ||
        !result.VersionStages?.includes("AWSCURRENT")
      ) {
        throw new DependencyUnavailableError("Secret update response does not match its binding.");
      }
    }, true);
  }

  async delete(secret: Secret): Promise<void> {
    const result = await this.owned(secret, true);
    if (result.DeletedDate) {
      return;
    }
    const binding = this.ownership.resource(secret);
    const client = this.createClients(await this.signingCredentials()).secrets;
    await awsRequest(async (abortSignal) => {
      const deleted = await sendMutation(() =>
        client.send(
          new DeleteSecretCommand({
            SecretId: binding.arn,
            RecoveryWindowInDays: 30,
          }),
          { abortSignal },
        ),
      );
      if (deleted.ARN !== binding.arn || deleted.Name !== binding.name || !deleted.DeletionDate) {
        throw new DependencyUnavailableError(
          "Secret deletion response does not match its binding.",
        );
      }
    }, true);
  }

  private async read(secret: Secret): Promise<VersionedSecretValue> {
    const version = this.current(await this.owned(secret));
    const binding = this.ownership.resource(secret);
    const result = await awsRequest((abortSignal) =>
      this.client.send(
        new GetSecretValueCommand({
          SecretId: binding.arn,
          VersionId: version,
          VersionStage: "AWSCURRENT",
        }),
        { abortSignal },
      ),
    );
    if (
      result.ARN !== binding.arn ||
      result.Name !== binding.name ||
      result.VersionId !== version ||
      !result.VersionStages?.includes("AWSCURRENT") ||
      typeof result.SecretString !== "string" ||
      result.SecretBinary !== undefined
    ) {
      throw new DependencyUnavailableError(
        "Secret read response does not match its current version.",
      );
    }
    this.ownership.validateValue(result.SecretString);
    if (this.current(await this.owned(secret)) !== version) {
      throw new DependencyUnavailableError("Secret rotated during the read.");
    }
    return {
      value: result.SecretString,
      version,
      authoritativeObservedAt: new Date().toISOString(),
    };
  }

  async withValue<T>(secret: Secret, use: (value: string) => Promise<T>): Promise<T> {
    return use((await this.read(secret)).value);
  }

  async readCredentialInput(input: CredentialInputRead): Promise<VersionedSecretValue> {
    if (input.retention !== "none") {
      throw new ScopeViolationError("Credential retention must be none.");
    }
    return withComputeOperationDeadline(input.lifetime, async (lifetime) => {
      const result = await this.read(input.secret);
      lifetime.signal.throwIfAborted();
      if (Date.now() >= lifetime.deadline) {
        throw new DependencyUnavailableError("AWS Secret credential read deadline elapsed.");
      }
      return result;
    });
  }
}
