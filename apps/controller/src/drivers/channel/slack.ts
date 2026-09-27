import type { ChannelDirectoryResult, ChannelDriver } from "@openclaw-enterprise/contracts";
import { ChannelDirectoryError } from "@openclaw-enterprise/occ";
import { isIP } from "node:net";
import { fetch as undiciFetch, ProxyAgent } from "undici";

const SLACK_API = "https://slack.com/api/";
const PAGE_SIZE = 100;
const SEARCH_PAGES = 3;
const REQUEST_TIMEOUT_MS = 8_000;
const INFO_BATCH_SIZE = 5;
const PROXY_ENDPOINT =
  /^https?:\/\/((?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}):([1-9][0-9]{0,4})$/;

type SlackRecord = Record<string, unknown>;

function record(value: unknown): SlackRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as SlackRecord)
    : undefined;
}

function boundedString(value: unknown, maxLength = 200): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

function candidate(value: unknown, kind: "users" | "channels") {
  const entry = record(value);
  if (!entry || entry.deleted === true || entry.is_archived === true) {
    return undefined;
  }
  const id = boundedString(entry.id, 32);
  if (!id || !(kind === "users" ? /^[UW][A-Z0-9]+$/ : /^[CG][A-Z0-9]+$/).test(id)) {
    return undefined;
  }
  const profile = record(entry.profile);
  const name = boundedString(entry.name) ?? id;
  const displayName =
    kind === "users"
      ? (boundedString(profile?.display_name) ?? boundedString(profile?.real_name))
      : undefined;
  return { id, name, ...(displayName === undefined ? {} : { displayName }) };
}

function matchesQuery(
  value: { readonly id: string; readonly name: string; readonly displayName?: string },
  query: string,
  source: unknown,
): boolean {
  const entry = record(source);
  const profile = record(entry?.profile);
  return (
    query.length === 0 ||
    [
      value.id,
      value.name,
      value.displayName ?? "",
      boundedString(entry?.real_name) ?? "",
      boundedString(profile?.real_name) ?? "",
    ].some((part) => part.toLocaleLowerCase().includes(query))
  );
}

/** A bundled Channel Driver for bounded, read-only Slack directory discovery. */
export class SlackChannelDriver implements ChannelDriver {
  readonly capability = "channel" as const;
  readonly id = "slack-channel";
  readonly implementation = "occ/slack-channel";
  private readonly request: typeof fetch;
  private readonly proxy?: ProxyAgent;

  constructor(request: typeof fetch = globalThis.fetch, proxyUrl?: string) {
    this.request = request;
    if (proxyUrl !== undefined) {
      const endpoint = PROXY_ENDPOINT.exec(proxyUrl);
      const address = endpoint?.[1];
      const port = endpoint?.[2];
      if (
        address === undefined ||
        port === undefined ||
        isIP(address) !== 4 ||
        Number(port) > 65535
      ) {
        throw new Error(
          "Slack directory proxy must be an HTTP(S) literal IPv4 endpoint with an explicit port.",
        );
      }
      this.proxy = new ProxyAgent(proxyUrl);
    }
  }

  private async call(
    method: "auth.test" | "users.list" | "conversations.list" | "users.info" | "conversations.info",
    token: string,
    parameters: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<SlackRecord> {
    const url = new URL(method, SLACK_API);
    if (method !== "auth.test") {
      url.search = parameters.toString();
    }
    let response: Pick<Response, "status" | "ok" | "text">;
    try {
      const options = {
        method: method === "auth.test" ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}` },
        signal:
          signal === undefined
            ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            : AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      };
      // Node's built-in fetch does not use an external Undici dispatcher.
      response =
        this.proxy === undefined
          ? await this.request(url, options)
          : await undiciFetch(url, { ...options, dispatcher: this.proxy });
    } catch {
      throw new ChannelDirectoryError("unavailable");
    }
    if (response.status === 429) {
      throw new ChannelDirectoryError("rate_limited");
    }
    if (!response.ok) {
      throw new ChannelDirectoryError("unavailable");
    }
    let body: SlackRecord | undefined;
    try {
      const content = await response.text();
      body = content.length <= 2_000_000 ? record(JSON.parse(content)) : undefined;
    } catch {
      throw new ChannelDirectoryError("invalid_response");
    }
    if (!body || typeof body.ok !== "boolean") {
      throw new ChannelDirectoryError("invalid_response");
    }
    if (!body.ok) {
      if (
        (method === "users.info" &&
          (body.error === "user_not_found" || body.error === "user_not_visible")) ||
        (method === "conversations.info" && body.error === "channel_not_found") ||
        ((method === "users.info" || method === "conversations.info") &&
          (body.error === "no_permission" || body.error === "access_denied"))
      ) {
        return body;
      }
      if (
        body.error === "missing_scope" ||
        body.error === "not_allowed_token_type" ||
        (method === "conversations.list" && body.error === "invalid_types")
      ) {
        throw new ChannelDirectoryError("missing_scope");
      }
      if (
        body.error === "invalid_auth" ||
        body.error === "not_authed" ||
        body.error === "account_inactive" ||
        body.error === "token_expired" ||
        body.error === "token_revoked"
      ) {
        throw new ChannelDirectoryError("credentials_rejected");
      }
      if (body.error === "ratelimited") {
        throw new ChannelDirectoryError("rate_limited");
      }
      throw new ChannelDirectoryError("unavailable");
    }
    return body;
  }

  async lookupDirectory(
    input: {
      readonly token: string;
      readonly kind: "users" | "channels";
      readonly query?: string;
      readonly cursor?: string;
      readonly ids?: readonly string[];
    },
    signal?: AbortSignal,
  ): Promise<ChannelDirectoryResult> {
    const auth = await this.call("auth.test", input.token, new URLSearchParams(), signal);
    if (!/^B[A-Z0-9]+$/.test(boundedString(auth.bot_id, 32) ?? "")) {
      throw new ChannelDirectoryError("credentials_rejected");
    }
    const workspaceId = boundedString(auth.team_id, 32);
    if (!workspaceId || !/^T[A-Z0-9]+$/.test(workspaceId)) {
      throw new ChannelDirectoryError("invalid_response");
    }
    const workspaceName = boundedString(auth.team);
    if (input.ids !== undefined) {
      const method = input.kind === "users" ? "users.info" : "conversations.info";
      const parameter = input.kind === "users" ? "user" : "channel";
      const candidates: ChannelDirectoryResult["candidates"][number][] = [];
      for (let offset = 0; offset < input.ids.length; offset += INFO_BATCH_SIZE) {
        const batch = await Promise.all(
          input.ids.slice(offset, offset + INFO_BATCH_SIZE).map(async (id) => {
            if (!(input.kind === "users" ? /^[UW][A-Z0-9]+$/ : /^[CG][A-Z0-9]+$/).test(id)) {
              return undefined;
            }
            const reply = await this.call(
              method,
              input.token,
              new URLSearchParams({ [parameter]: id }),
              signal,
            );
            return reply.ok
              ? candidate(reply[input.kind === "users" ? "user" : "channel"], input.kind)
              : undefined;
          }),
        );
        for (let index = 0; index < batch.length; index += 1) {
          const found = batch[index];
          if (found !== undefined && found.id === input.ids[offset + index]) {
            candidates.push(found);
          }
        }
      }
      return {
        workspaceId,
        ...(workspaceName === undefined ? {} : { workspaceName }),
        candidates,
        complete: true,
      };
    }
    const query = (input.query ?? "").trim().replace(/^[@#]/, "").toLocaleLowerCase();
    const candidates: ChannelDirectoryResult["candidates"][number][] = [];
    const seen = new Set<string>();
    let cursor = input.cursor ?? "";
    const method = input.kind === "users" ? "users.list" : "conversations.list";
    for (let page = 0; page < (query ? SEARCH_PAGES : 1); page += 1) {
      const parameters = new URLSearchParams({ limit: String(PAGE_SIZE - candidates.length) });
      if (cursor) {
        parameters.set("cursor", cursor);
      }
      parameters.set("team_id", workspaceId);
      if (input.kind === "channels") {
        parameters.set("types", "public_channel,private_channel");
        parameters.set("exclude_archived", "true");
      }
      const reply = await this.call(method, input.token, parameters, signal);
      const entries = reply[input.kind === "users" ? "members" : "channels"];
      if (!Array.isArray(entries)) {
        throw new ChannelDirectoryError("invalid_response");
      }
      for (const entry of entries) {
        const found = candidate(entry, input.kind);
        if (found && !seen.has(found.id) && matchesQuery(found, query, entry)) {
          seen.add(found.id);
          candidates.push(found);
        }
      }
      const nextCursor = record(reply.response_metadata)?.next_cursor;
      if (nextCursor !== undefined && typeof nextCursor !== "string") {
        throw new ChannelDirectoryError("invalid_response");
      }
      cursor = nextCursor ?? "";
      if (!cursor || candidates.length >= PAGE_SIZE) {
        break;
      }
    }
    return {
      workspaceId,
      ...(workspaceName === undefined ? {} : { workspaceName }),
      candidates,
      ...(cursor ? { nextCursor: cursor } : {}),
      complete: !cursor,
    };
  }
}
