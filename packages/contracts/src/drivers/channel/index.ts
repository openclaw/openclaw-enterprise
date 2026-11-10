import type { Driver } from "../index.ts";

export interface ChannelDirectoryLookupInput {
  readonly token: string;
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
  validateCredentials?(
    values: Readonly<Record<string, unknown>>,
    withSecret: ChannelCredentialReader,
  ): Promise<void>;
  lookupDirectory(
    input: ChannelDirectoryLookupInput,
    signal?: AbortSignal,
  ): Promise<ChannelDirectoryResult>;
}
