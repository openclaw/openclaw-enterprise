import type { Driver } from "../index.ts";
import type { JSONSchema } from "../../index.ts";
import type { NetworkDestinationRule } from "../../network-destination.ts";

export interface ChannelDirectoryLookupInput {
  readonly token: string;
  /** Nonsecret provider lookup fields, such as a tenant ID; see `directoryContextSchema`. */
  readonly context?: Readonly<Record<string, string>>;
  readonly kind: "users" | "channels";
  readonly query?: string;
  readonly cursor?: string;
  readonly ids?: readonly string[];
}

export interface ChannelDirectoryResult {
  readonly workspaceId: string;
  readonly workspaceName?: string;
  readonly candidates: readonly {
    readonly id: string;
    readonly name: string;
    readonly displayName?: string;
  }[];
  readonly nextCursor?: string;
  readonly complete: boolean;
}

/** Values stay inside the Secret Driver callback; adapters own native field semantics. */
export type ChannelCredentialReader = (
  binding: string,
  path: string,
  validate: (value: string) => Promise<void>,
) => Promise<void>;

export interface ChannelDriver extends Driver {
  readonly capability: "channel";
  /** Deterministic provider requirements; never reads credentials or changes infrastructure. */
  enableRouting(): readonly NetworkDestinationRule[];
  /**
   * JSON Schema of this provider's lookup fields in `context`. OCC validates every
   * lookup's `context`, an absent one as `{}`, before it reads the credential. A
   * provider without lookup fields returns a closed empty object schema.
   */
  directoryContextSchema(): JSONSchema;
  /** Checks only this Driver's provider section; an absent or disabled section passes. */
  validateCredentials?(
    values: Readonly<Record<string, unknown>>,
    withSecret: ChannelCredentialReader,
  ): Promise<void>;
  lookupDirectory(
    input: ChannelDirectoryLookupInput,
    signal?: AbortSignal,
  ): Promise<ChannelDirectoryResult>;
}

/** Trusted composition binds each provider ID to exactly one installed Channel Driver. */
export interface ChannelProviderDriver {
  readonly provider: string;
  readonly driver: ChannelDriver;
}
