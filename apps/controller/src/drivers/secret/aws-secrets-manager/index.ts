import { createHash, randomUUID } from "node:crypto";
import { Agent } from "node:https";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
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
import {
  currentComputeAbortSignal,
  withComputeOperationDeadline,
} from "../../compute/operation-context.ts";

export interface AwsSecretsManagerOptions {
  readonly region: string;
  readonly accountId: string;
  readonly prefix: string;
  readonly kmsKeyId?: string;
}

/** AWS resource tags must also be protected by the operator's IAM policy. */
export class AwsSecretsManagerSecretDriver implements SecretDriver {
  static readonly configurationSchema: JSONSchema = {
    type: "object",
    additionalProperties: false,
    required: ["region", "accountId", "prefix"],
    properties: {
      region: { type: "string", pattern: "^[a-z]{2}(-[a-z]+)+-[0-9]+$" },
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
      endpoint: this.endpoint("secretsmanager"),
    });
    this.client = selection.client ?? defaults;
    this.credentials = defaults.config.credentials;
    this.createClients = (credentials) => ({
      secrets:
        selection.client ??
        new SecretsManagerClient({
          ...common,
          credentials: { ...credentials },
          endpoint: this.endpoint("secretsmanager"),
        }),
      identity:
        selection.identityClient ??
        new STSClient({
          ...common,
          credentials: { ...credentials },
          endpoint: this.endpoint("sts"),
        }),
    });
  }

  private endpoint(service: "sts" | "secretsmanager"): string {
    const domain = this.partition() === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com";
    return `https://${service}.${this.options.region}.${domain}`;
  }

  private namespace(identity: SecretIdentity): string {
    if (
      !/^ns_[A-Za-z0-9_-]+$/.test(identity.namespaceId) ||
      !/^sec_[A-Za-z0-9_-]+$/.test(identity.id) ||
      !identity.name?.trim()
    ) {
      throw new ScopeViolationError("Invalid Secret identity.");
    }
    return `${this.options.prefix}/${identity.namespaceId}`;
  }

  private tags(identity: SecretIdentity) {
    return [
      { Key: "openclaw:managed-by", Value: "openclaw-enterprise" },
      { Key: "openclaw:namespace", Value: identity.namespaceId },
      { Key: "openclaw:secret", Value: identity.id },
      { Key: "openclaw:driver", Value: this.id },
    ];
  }

  private validateValue(value: string): void {
    if (
      typeof value !== "string" ||
      !value.length ||
      value.includes("\0") ||
      !value.isWellFormed() ||
      Buffer.byteLength(value, "utf8") > 65_536
    ) {
      throw new ScopeViolationError("Invalid Secret value.");
    }
  }

  private digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  private location(identity: SecretIdentity): string {
    return `aws-sm-${this.digest(JSON.stringify([this.options.region, this.options.accountId, this.namespace(identity)])).slice(0, 48)}`;
  }

  private partition(): string {
    if (this.options.region.startsWith("cn-")) {
      return "aws-cn";
    }
    if (this.options.region.startsWith("us-gov-")) {
      return "aws-us-gov";
    }
    return "aws";
  }

  // OCC persists DNS-shaped names and a UUID. Bind the reconstructed complete ARN
  // without broadening that shared format or accepting a replacement AWS suffix.
  private binding(secret: Secret): { arn: string; name: string } {
    const ref = secret.backendRef;
    const name = `${this.namespace(secret)}/${secret.id}/${ref.uid}`;
    const match = /^aws-sm-([0-9a-f]{12})\.([0-9a-f]{32})\.([0-9a-f]{32})$/.exec(ref.name);
    if (
      secret.driverId !== this.id ||
      ref.namespaceName !== this.location(secret) ||
      ref.key !== "SecretString" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ref.uid) ||
      !match
    ) {
      throw new ScopeViolationError("Secret ownership binding changed.");
    }
    const suffix = Buffer.from(match[1]!, "hex").toString("ascii");
    const arn = `arn:${this.partition()}:secretsmanager:${this.options.region}:${this.options.accountId}:secret:${name}-${suffix}`;
    this.checkArn(arn, name);
    if (this.digest(arn) !== `${match[2]}${match[3]}`) {
      throw new ScopeViolationError("Secret ARN binding changed.");
    }
    return { arn, name };
  }

  private checkArn(arn: string | undefined, name: string): asserts arn is string {
    const parts = arn?.split(":");
    if (
      !parts ||
      parts.length !== 7 ||
      parts[0] !== "arn" ||
      parts[1] !== this.partition() ||
      parts[2] !== "secretsmanager" ||
      parts[3] !== this.options.region ||
      parts[4] !== this.options.accountId ||
      parts[5] !== "secret" ||
      !parts[6]?.startsWith(`${name}-`) ||
      parts[6].slice(name.length + 1).match(/^[A-Za-z0-9]{6}$/) === null
    ) {
      throw new ScopeViolationError("Secret ARN does not match its binding.");
    }
  }

  private async request<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    mutation = false,
  ): Promise<T> {
    const parent = currentComputeAbortSignal();
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(parent ? [parent] : [])]);
    let submitted = false;
    let abort: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      // Mutation callbacks submit immediately; their response verification remains
      // inside this boundary. Pre-aborted requests never reach submission.
      submitted = mutation;
      const result = await Promise.race([operation(signal), cancelled]);
      signal.throwIfAborted();
      return result;
    } catch {
      // Do not expose AWS diagnostics, values, or credentials. Never recover by name.
      throw new DependencyUnavailableError(
        submitted
          ? "AWS Secret mutation may have applied; reconciliation required."
          : "AWS Secret operation failed; no mutation was submitted.",
      );
    } finally {
      if (abort) {
        signal.removeEventListener("abort", abort);
      }
    }
  }

  private async signingCredentials() {
    return this.request(async () => {
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
    const namespaceName = this.namespace(identity);
    this.validateValue(value);
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
    const caller = await this.request((abortSignal) =>
      clients.identity.send(new GetCallerIdentityCommand({}), { abortSignal }),
    );
    if (caller.Account !== this.options.accountId) {
      throw new ScopeViolationError("AWS caller account does not match Secret configuration.");
    }
    return this.request(async (abortSignal) => {
      const result = await clients.secrets.send(
        new CreateSecretCommand({
          Name: name,
          SecretString: value,
          ClientRequestToken: token,
          Tags: this.tags(identity),
          ...(this.options.kmsKeyId ? { KmsKeyId: this.options.kmsKeyId } : {}),
        }),
        { abortSignal },
      );
      abortSignal.throwIfAborted();
      this.checkArn(result.ARN, name);
      if (result.Name !== name || result.VersionId !== token) {
        throw new ScopeViolationError("Secret create response does not match its binding.");
      }
      const suffix = Buffer.from(result.ARN.slice(-6), "ascii").toString("hex");
      const reference = Object.freeze({
        namespaceName: this.location(identity),
        name: `aws-sm-${suffix}.${this.digest(result.ARN).slice(0, 32)}.${this.digest(result.ARN).slice(32)}`,
        uid,
        key: "SecretString",
      });
      const observed = await this.owned(
        {
          ...identity,
          backendRef: reference,
          driverId: this.id,
          createdAt: new Date().toISOString(),
        },
        false,
        clients.secrets,
      );
      if (this.current(observed) !== token) {
        throw new DependencyUnavailableError(
          "Secret changed during creation; outcome may be unknown.",
        );
      }
      return reference;
    }, true);
  }

  private async owned(
    secret: Secret,
    deleting = false,
    client = this.client,
  ): Promise<DescribeSecretCommandOutput> {
    const { arn, name } = this.binding(secret);
    const result = await this.request((abortSignal) =>
      client.send(new DescribeSecretCommand({ SecretId: arn }), { abortSignal }),
    );
    if (
      result.ARN !== arn ||
      result.Name !== name ||
      this.tags(secret).some(
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

  async resolve(secret: Secret): Promise<SecretBackendRef> {
    this.current(await this.owned(secret));
    return Object.freeze({ ...secret.backendRef });
  }

  async update(secret: Secret, value: string): Promise<void> {
    this.validateValue(value);
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
    const binding = this.binding(secret);
    const client = this.createClients(await this.signingCredentials()).secrets;
    await this.request(async (abortSignal) => {
      const result = await client.send(
        new PutSecretValueCommand({
          SecretId: binding.arn,
          SecretString: value,
          ClientRequestToken: token,
          VersionStages: ["AWSCURRENT"],
        }),
        { abortSignal },
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
    const binding = this.binding(secret);
    const client = this.createClients(await this.signingCredentials()).secrets;
    await this.request(async (abortSignal) => {
      const deleted = await client.send(
        new DeleteSecretCommand({
          SecretId: binding.arn,
          RecoveryWindowInDays: 30,
        }),
        { abortSignal },
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
    const result = await this.request((abortSignal) =>
      this.client.send(
        new GetSecretValueCommand({
          SecretId: this.binding(secret).arn,
          VersionId: version,
          VersionStage: "AWSCURRENT",
        }),
        { abortSignal },
      ),
    );
    if (
      result.ARN !== this.binding(secret).arn ||
      result.Name !== this.binding(secret).name ||
      result.VersionId !== version ||
      !result.VersionStages?.includes("AWSCURRENT") ||
      typeof result.SecretString !== "string" ||
      result.SecretBinary !== undefined
    ) {
      throw new DependencyUnavailableError(
        "Secret read response does not match its current version.",
      );
    }
    this.validateValue(result.SecretString);
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
      return result;
    });
  }
}
