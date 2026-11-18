import { createHash } from "node:crypto";
import type { Secret, SecretIdentity } from "@openclaw-enterprise/contracts";
import { ScopeViolationError } from "@openclaw-enterprise/occ";

export interface AwsSecretsManagerOptions {
  readonly region: string;
  readonly accountId: string;
  readonly prefix: string;
  readonly kmsKeyId?: string;
}

/** Reconstruct and verify exact AWS resource ownership from OCC metadata. */
export class AwsSecretBinding {
  private readonly options: Readonly<AwsSecretsManagerOptions>;
  private readonly id: string;

  constructor(options: Readonly<AwsSecretsManagerOptions>, id: string) {
    this.options = options;
    this.id = id;
  }

  endpoint(service: "sts" | "secretsmanager"): string {
    const domain = this.partition() === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com";
    return `https://${service}.${this.options.region}.${domain}`;
  }

  namespace(identity: SecretIdentity): string {
    if (
      !/^ns_[A-Za-z0-9_-]+$/.test(identity.namespaceId) ||
      !/^sec_[A-Za-z0-9_-]+$/.test(identity.id) ||
      !identity.name?.trim()
    ) {
      throw new ScopeViolationError("Invalid Secret identity.");
    }
    return `${this.options.prefix}/${identity.namespaceId}`;
  }

  tags(identity: SecretIdentity) {
    return [
      { Key: "openclaw:managed-by", Value: "openclaw-enterprise" },
      { Key: "openclaw:namespace", Value: identity.namespaceId },
      { Key: "openclaw:secret", Value: identity.id },
      { Key: "openclaw:driver", Value: this.id },
    ];
  }

  validateValue(value: string): void {
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

  digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  location(identity: SecretIdentity): string {
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
  resource(secret: Secret): { arn: string; name: string } {
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

  checkArn(arn: string | undefined, name: string): asserts arn is string {
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
}
