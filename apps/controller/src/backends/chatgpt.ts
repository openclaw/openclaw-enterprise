import { DependencyUnavailableError } from "@openclaw-enterprise/occ";

const CHATGPT_API_BASE = "https://api.chatgpt.com/v1";
const CODEX_LOCAL_ACCESS_SCOPE = "chatgpt.workspace.feature.allow-codex-local-access.access";
const MAX_CREDENTIAL_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChatGPTClientOptions {
  readonly workspaceId: string;
  readonly adminKey: string;
  readonly credentialTtlSeconds?: number;
}

interface ChatGPTAccount {
  readonly id: string;
}

interface ChatGPTCredential {
  readonly id: string;
  readonly accessToken: string;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function identifier(value: string): string {
  if (!nonempty(value)) {
    throw new DependencyUnavailableError("The ChatGPT account identity is invalid.");
  }
  return encodeURIComponent(value);
}

export class ChatGPTClient {
  readonly workspaceId: string;
  private readonly adminKey: string;
  private readonly credentialTtlSeconds: number;

  constructor(options: ChatGPTClientOptions) {
    if (!WORKSPACE_ID.test(options.workspaceId)) {
      throw new Error("The ChatGPT Backend requires a valid workspace ID.");
    }
    if (!nonempty(options.adminKey) || /[\r\n]/.test(options.adminKey)) {
      throw new Error("The ChatGPT Backend requires a valid mounted admin credential.");
    }
    const ttl = options.credentialTtlSeconds ?? MAX_CREDENTIAL_TTL_SECONDS;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_CREDENTIAL_TTL_SECONDS) {
      throw new Error("The ChatGPT credential lifetime must be between one second and 30 days.");
    }

    this.workspaceId = options.workspaceId;
    this.adminKey = options.adminKey;
    this.credentialTtlSeconds = ttl;
  }

  async createServiceAccount(input: { readonly name: string }): Promise<ChatGPTAccount> {
    const resource = await this.request("POST", this.accountPath(), { name: input.name });
    if (
      !nonempty(resource.id) ||
      resource.workspace_id !== this.workspaceId ||
      resource.enabled !== true
    ) {
      throw new DependencyUnavailableError("ChatGPT returned an invalid service account.");
    }
    return { id: resource.id };
  }

  async deleteServiceAccount(accountId: string): Promise<void> {
    const resource = await this.request("DELETE", this.accountPath(accountId), undefined, {
      id: accountId,
      codes: ["service_account_not_found"],
    });
    if (resource.id !== accountId || resource.deleted !== true) {
      throw new DependencyUnavailableError("ChatGPT did not confirm service-account deletion.");
    }
  }

  async createCredential(input: {
    readonly accountId: string;
    readonly name: string;
  }): Promise<ChatGPTCredential> {
    const resource = await this.request(
      "POST",
      `${this.accountPath(input.accountId)}/credentials`,
      {
        name: input.name,
        ttl: this.credentialTtlSeconds,
        scopes: [CODEX_LOCAL_ACCESS_SCOPE],
      },
    );
    if (
      !nonempty(resource.id) ||
      !nonempty(resource.access_token) ||
      resource.workspace_id !== this.workspaceId ||
      resource.service_account_id !== input.accountId ||
      !Array.isArray(resource.scopes) ||
      resource.scopes.length !== 1 ||
      resource.scopes[0] !== CODEX_LOCAL_ACCESS_SCOPE ||
      !Number.isSafeInteger(resource.expires_at)
    ) {
      throw new DependencyUnavailableError(
        "ChatGPT returned an invalid service-account credential.",
      );
    }
    return { id: resource.id, accessToken: resource.access_token };
  }

  async deleteCredential(input: {
    readonly accountId: string;
    readonly credentialId: string;
  }): Promise<void> {
    const resource = await this.request(
      "DELETE",
      `${this.accountPath(input.accountId)}/credentials/${identifier(input.credentialId)}`,
      undefined,
      {
        id: input.credentialId,
        codes: ["credential_not_found", "service_account_not_found"],
      },
    );
    if (resource.id !== input.credentialId || resource.deleted !== true) {
      throw new DependencyUnavailableError("ChatGPT did not confirm credential deletion.");
    }
  }

  private accountPath(accountId?: string): string {
    const accounts = `/manage/workspaces/${this.workspaceId}/service-accounts`;
    return accountId === undefined ? accounts : `${accounts}/${identifier(accountId)}`;
  }

  private async request(
    method: "POST" | "DELETE",
    path: string,
    body?: Readonly<Record<string, unknown>>,
    alreadyAbsent?: { readonly id: string; readonly codes: readonly string[] },
  ): Promise<Readonly<Record<string, unknown>>> {
    let response: Response;
    try {
      response = await fetch(`${CHATGPT_API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.adminKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new DependencyUnavailableError(`ChatGPT Admin API ${method} request was unavailable.`);
    }

    if (!response.ok) {
      if (method === "DELETE" && response.status === 404 && alreadyAbsent !== undefined) {
        const result = await this.responseBody(response);
        const error = result.error;
        if (
          typeof error === "object" &&
          error !== null &&
          !Array.isArray(error) &&
          alreadyAbsent.codes.includes((error as Readonly<Record<string, unknown>>).code as string)
        ) {
          return { id: alreadyAbsent.id, deleted: true };
        }
      }
      throw new DependencyUnavailableError(
        `ChatGPT Admin API ${method} request failed with HTTP ${response.status}.`,
      );
    }

    return this.responseBody(response);
  }

  private async responseBody(response: Response): Promise<Readonly<Record<string, unknown>>> {
    try {
      const declaredLength = Number(response.headers.get("content-length"));
      if (declaredLength > MAX_RESPONSE_BYTES) {
        throw new Error("oversized");
      }
      const contents = await response.text();
      if (Buffer.byteLength(contents) > MAX_RESPONSE_BYTES) {
        throw new Error("oversized");
      }
      const parsed: unknown = JSON.parse(contents);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("invalid");
      }
      return parsed as Readonly<Record<string, unknown>>;
    } catch {
      throw new DependencyUnavailableError("ChatGPT Admin API returned an invalid response.");
    }
  }
}
