import type {
  ChannelCredentialReader,
  ChannelDirectoryResult,
  ChannelDriver,
} from "@openclaw-enterprise/contracts";
import {
  ChannelCredentialError,
  ChannelDirectoryError,
  ResourceStateConflictError,
  slackAccountTargets,
  wholeEnvironmentReferenceName,
} from "@openclaw-enterprise/occ";
import { asRecord, readCappedBody } from "@openclaw-enterprise/utils";
import { isIP } from "node:net";
import { fetch as undiciFetch, ProxyAgent, type Response as UndiciResponse } from "undici";

const SLACK_API = "https://slack.com/api/";
const PAGE_SIZE = 100;
const SEARCH_PAGES = 3;
const REQUEST_TIMEOUT_MS = 8_000;
const INFO_BATCH_SIZE = 5;
const PROXY_ENDPOINT =
  /^https?:\/\/((?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}):([1-9][0-9]{0,4})$/;
const MANAGED_SERVICE_PROXY_ENDPOINT =
  /^https?:\/\/([a-z]([-a-z0-9]*[a-z0-9])?\.[a-z0-9]([-a-z0-9]*[a-z0-9])?\.svc):([1-9][0-9]{0,4})$/;

type SlackRecord = Record<string, unknown>;

/**
 * Finding 2521: the production API's egress is default-deny unless sign-in settings open it. With
 * no Slack proxy configured, a token check that gets no answer from Slack usually means the
 * Installation has no Slack route, but an open route can also time out (finding 2531). The fixed
 * text names the setting and keeps the retry for that case. It is raised only after the binding
 * and token-prefix checks, and it names no token. The error contract caps messages at 256
 * characters.
 */
export class SlackRouteNotConfiguredError extends ResourceStateConflictError {
  constructor() {
    super(
      "OCC could not reach Slack, and the API has no Slack proxy. If the API has another approved route to Slack, try again. Otherwise an administrator must set Helm slackProxy.enabled or api.channelDirectoryProxyUrl; see the Slack integration guide.",
    );
    this.name = "SlackRouteNotConfiguredError";
  }
}

/** A request that got no HTTP answer: no connection, no DNS answer, or the time budget ran out. */
class SlackUnansweredError extends ChannelDirectoryError {
  constructor() {
    super("unavailable");
  }
}

// Fetch failure causes that mean Slack never answered (finding 2532). A redirect that
// `redirect: "error"` refuses, a TLS failure or an invalid header value is a different failure.
const UNANSWERED_CAUSES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function neverAnswered(error: unknown): boolean {
  const failure = asRecord(error);
  return (
    failure?.name === "TimeoutError" ||
    UNANSWERED_CAUSES.has(String(asRecord(failure?.cause)?.code))
  );
}

function boundedString(value: unknown, maxLength = 200): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

function candidate(value: unknown, kind: "users" | "channels") {
  const entry = asRecord(value);
  if (!entry || entry.deleted === true || entry.is_archived === true) {
    return undefined;
  }
  const id = boundedString(entry.id, 32);
  if (!id || !(kind === "users" ? /^[UW][A-Z0-9]+$/ : /^[CG][A-Z0-9]+$/).test(id)) {
    return undefined;
  }
  const profile = asRecord(entry.profile);
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
  const entry = asRecord(source);
  const profile = asRecord(entry?.profile);
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

/** A bundled Channel Driver for bounded Slack admission and read-only discovery. */
export class SlackChannelDriver implements ChannelDriver {
  readonly capability = "channel" as const;
  readonly id = "slack-channel";
  readonly implementation = "occ/slack-channel";
  private readonly request: typeof fetch;
  private readonly proxy?: ProxyAgent;
  // Production sets expectProxy: its default-deny API egress reaches Slack through a configured
  // proxy. Without one, an unanswered check names that setting; a route an operator approved
  // instead still works.
  private readonly proxyMissing: boolean;

  constructor(
    request: typeof fetch = globalThis.fetch,
    proxyUrl?: string,
    options: {
      readonly managedProxyHosts?: readonly string[];
      readonly expectProxy?: boolean;
    } = {},
  ) {
    this.request = request;
    this.proxyMissing = options.expectProxy === true && proxyUrl === undefined;
    if (proxyUrl !== undefined) {
      const endpoint = PROXY_ENDPOINT.exec(proxyUrl);
      const managedEndpoint = MANAGED_SERVICE_PROXY_ENDPOINT.exec(proxyUrl);
      const address = endpoint?.[1];
      const managedHost = managedEndpoint?.[1];
      const managedService =
        managedHost !== undefined && (options.managedProxyHosts ?? []).includes(managedHost);
      const port = endpoint?.[2] ?? managedEndpoint?.[4];
      if (port === undefined || Number(port) > 65535) {
        throw new Error(
          "Slack directory proxy must be an HTTP(S) literal IPv4 endpoint or the exact managed Kubernetes Service endpoint with an explicit port.",
        );
      }
      if (!managedService && (address === undefined || isIP(address) !== 4)) {
        throw new Error(
          "Slack directory proxy must be an HTTP(S) literal IPv4 endpoint or the exact managed Kubernetes Service endpoint with an explicit port.",
        );
      }
      // Like Compute's channel proxy rule: the unspecified address names no proxy.
      if (address === "0.0.0.0") {
        throw new Error(
          "Slack directory proxy must not use host 0.0.0.0, which names no proxy address.",
        );
      }
      this.proxy = new ProxyAgent(proxyUrl);
    }
  }

  async validateCredentials(
    values: Readonly<Record<string, unknown>>,
    withSecret: ChannelCredentialReader,
  ): Promise<void> {
    const slack = asRecord(asRecord(values.channels)?.slack);
    if (slack === undefined || slack.enabled === false) {
      return;
    }
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    // OpenClaw still starts an implicit "default" account from the top-level bot and app
    // tokens when named accounts exist, unless one of them is named "default".
    const targets = slackAccountTargets(slack).map(({ account, config }) => ({
      config,
      path:
        account === undefined
          ? "/channels/slack"
          : `/channels/slack/accounts/${account.replaceAll("~", "~0").replaceAll("/", "~1")}`,
    }));
    for (const { config, path } of targets) {
      if (config.enabled === false) {
        continue;
      }
      for (const role of ["appToken", "botToken"] as const) {
        if (role === "appToken" && config.mode === "http") {
          continue;
        }
        const field = `${path}/${role}`;
        // OpenClaw reads a token that is exactly one `${NAME}` as the env SecretRef to NAME, and
        // Configuration save accepts that form (finding 2511). Any other string stays refused.
        const token = config[role];
        const whole = typeof token === "string" ? wholeEnvironmentReferenceName(token) : undefined;
        const ref: Record<string, unknown> | undefined =
          whole === undefined ? asRecord(token) : { source: "env", id: whole };
        if (
          ref?.source !== "env" ||
          (ref.provider !== undefined && ref.provider !== "default") ||
          typeof ref.id !== "string" ||
          !/^[A-Za-z_][A-Za-z0-9_]{0,252}$/.test(ref.id)
        ) {
          throw new ChannelCredentialError("binding_required", field);
        }
        let unanswered = false;
        await withSecret(ref.id, field, async (value) => {
          if (!(role === "appToken" ? /^xapp-/ : /^xoxb-/).test(value)) {
            throw new ChannelCredentialError("role_mismatch", field);
          }
          // There is no app-token auth.test equivalent. Do not open a Socket Mode consumer.
          if (role === "appToken") {
            return;
          }
          try {
            const identity = await this.call("auth.test", value, new URLSearchParams(), signal);
            if (typeof identity.bot_id !== "string" || !/^B[A-Z0-9]+$/.test(identity.bot_id)) {
              throw new ChannelCredentialError("credentials_rejected", field);
            }
            const validIdentity =
              identity.is_enterprise_install === true
                ? typeof identity.enterprise_id === "string" &&
                  /^E[A-Z0-9]+$/.test(identity.enterprise_id)
                : typeof identity.team_id === "string" && /^T[A-Z0-9]+$/.test(identity.team_id);
            if (!validIdentity) {
              throw new ChannelCredentialError("unavailable", field);
            }
          } catch (error) {
            if (error instanceof ChannelCredentialError) {
              throw error;
            }
            if (error instanceof SlackUnansweredError && this.proxyMissing) {
              // Refused below: OCC wraps any other error from this callback as unavailable.
              unanswered = true;
              return;
            }
            throw new ChannelCredentialError(
              error instanceof ChannelDirectoryError &&
                ["credentials_rejected", "missing_scope"].includes(error.reason)
                ? "credentials_rejected"
                : "unavailable",
              field,
            );
          }
        });
        if (unanswered) {
          throw new SlackRouteNotConfiguredError();
        }
      }
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
    let response: Response | UndiciResponse;
    try {
      const options = {
        method: method === "auth.test" ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}` },
        // Never send the bot token to a redirect target, even on slack.com (finding 1349).
        redirect: "error" as const,
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
    } catch (error) {
      throw neverAnswered(error)
        ? new SlackUnansweredError()
        : new ChannelDirectoryError("unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ChannelDirectoryError(response.status === 429 ? "rate_limited" : "unavailable");
    }
    let body: SlackRecord | undefined;
    try {
      // Each UTF-16 unit decodes from at most three UTF-8 bytes, so a body over 8,000,000
      // bytes is always over the 2,000,000-character limit: stop reading there.
      const bytes = await readCappedBody(response.body, 8_000_000);
      const content = bytes === undefined ? undefined : new TextDecoder().decode(bytes);
      body =
        content !== undefined && content.length <= 2_000_000
          ? asRecord(JSON.parse(content))
          : undefined;
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
      const nextCursor = asRecord(reply.response_metadata)?.next_cursor;
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
