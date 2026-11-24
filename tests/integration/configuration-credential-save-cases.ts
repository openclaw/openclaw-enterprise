import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Check } from "typebox/value";
import type { ControllerApp } from "../../apps/controller/src/index.ts";
import {
  ConfigurationResponse,
  JsonValue,
  type OpenClawConfigurationDocument,
  type OpenClawConfigurationValue,
  type PresetDraftTemplate,
} from "../../packages/contracts/src/index.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";

interface SaveContext {
  app: ControllerApp;
  collection: string;
  presets: string;
  stored(): Promise<string[]>;
}

interface HttpResponse {
  status: number;
  body: unknown;
}

interface ConfigurationCredentialSaveFixtures {
  saveFixture(t: TestContext): Promise<SaveContext>;
  request(
    app: ControllerApp,
    method: "POST" | "GET",
    pathname: string,
    options?: { body: unknown },
  ): Promise<HttpResponse>;
  savePreset(context: SaveContext, template: PresetDraftTemplate): Promise<HttpResponse>;
  assertRefused(
    response: HttpResponse,
    message: string,
    options?: { label?: string; sentinel?: string },
  ): void;
  refusedOnSave(
    context: SaveContext,
    values: OpenClawConfigurationDocument,
    message: string,
    options: { item?: string; sentinel: string },
  ): Promise<void>;
  acceptedOnSave(
    context: SaveContext,
    values: OpenClawConfigurationDocument,
  ): Promise<HttpResponse>;
  assertNothingStored(context: SaveContext, kept: string[]): Promise<void>;
  referenceFormRefusal(
    setting: string,
    form: "inline" | "shorthand" | "fallback" | "otherText",
  ): string;
  at(field: string, value: OpenClawConfigurationValue): OpenClawConfigurationDocument;
  inline(field: string): string;
  literalKey(field: string): string;
  userinfo(field: string): string;
  gatewayPassword: string;
}

type CredentialRefusal = readonly [values: OpenClawConfigurationDocument, message: string];
type HeaderRefusal = readonly [root: string, header: string, value: string | number];

const schemaContext = { SafeJsonValue: JsonValue };
const environmentReference = (id: string) => ({ source: "env", provider: "default", id });

export function registerConfigurationCredentialSaveCases(
  fixtures: ConfigurationCredentialSaveFixtures,
): void {
  const {
    saveFixture,
    request,
    savePreset,
    assertRefused,
    refusedOnSave,
    acceptedOnSave,
    assertNothingStored,
    referenceFormRefusal,
    at,
    inline,
    literalKey,
    userinfo,
    gatewayPassword,
  } = fixtures;
  const literalHeader = (field: string) =>
    `${inline(field)} Make the header value a \${NAME} reference, or Bearer \${NAME} for an Authorization header.`;

  async function createEmptyConfiguration(context: SaveContext) {
    const created = await request(context.app, "POST", context.collection, {
      body: { kind: "agent", values: {} },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.ok(Check(schemaContext, ConfigurationResponse, created.body));
    return created.body.data;
  }

  async function assertNoCredentialWrite(
    context: SaveContext,
    original: Awaited<ReturnType<typeof createEmptyConfiguration>>,
  ): Promise<void> {
    // A refusal must leave the existing Configuration intact and create no new records.
    const saved = await request(context.app, "GET", `${context.collection}/${original.id}`);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.ok(Check(schemaContext, ConfigurationResponse, saved.body));
    assert.deepEqual(saved.body.data, original);
    await assertNothingStored(context, [`${original.id}.json`]);
  }

  test("Configuration and Preset saves refuse a literal credential in an MCP server header", async (t) => {
    // Finding 1278: OpenClaw marks MCP server headers sensitive, and a model provider's credential
    // headers already had to hold references, but an MCP server saved a literal `Authorization`.
    const context = await saveFixture(t);
    const original = await createEmptyConfiguration(context);
    const item = `${context.collection}/${original.id}`;
    const sentinel = `synthetic-mcp-header-${randomUUID()}`;
    const server = (headers: Readonly<Record<string, string | number>>) => ({
      url: "https://mcp.example.test/mcp",
      headers,
    });
    const refused: HeaderRefusal[] = [
      ["/mcp/servers/docs", "Authorization", `Bearer ${sentinel}`],
      ["/nodeHost/mcp/servers/docs", "X-Api-Key", sentinel],
      // `Bearer ${NAME}` holds a reference only in an Authorization header; a number is a literal.
      ["/mcp/servers/docs", "X-Auth-Token", "Bearer ${MCP_TOKEN}"],
      ["/mcp/servers/docs", "x-client-secret", 12345],
      ["/mcp/servers/docs", "Authorization", `Bearer ${sentinel}\${SUFFIX}`],
    ];
    for (const [root, header, value] of refused) {
      const field = `${root}/headers/${header}`;
      await t.test(`refuses ${field}`, async () => {
        const values = at(root, server({ [header]: value }));
        await refusedOnSave(context, values, literalHeader(field), { item, sentinel });
      });
    }
    // A Preset header name that waits on a variable is matched as the text around it.
    await t.test("refuses a Preset header name around a variable at save", async () => {
      const response = await savePreset(context, {
        variables: { suffix: { type: "string" } },
        configuration: {
          values: {
            mcp: { servers: { docs: server({ "Authorization{{ vars.suffix }}": sentinel }) } },
          },
        },
      });
      const field = "/mcp/servers/docs/headers/Authorization{{ vars.suffix }}";
      assertRefused(response, literalHeader(field), { label: field, sentinel });
    });
    await assertNoCredentialWrite(context, original);

    // Credential headers that hold references, and headers that name no credential, still save.
    const headers = {
      Authorization: "Bearer ${MCP_TOKEN}",
      "Authorization-V2": "Bearer ${MCP_TOKEN_V2}",
      "X-Api-Key": "${MCP_API_KEY}",
      "Proxy-Authorization": "${MCP_PROXY_AUTH}",
      Accept: "application/json",
      "X-Request-Source": "openclaw",
      "Idempotency-Key": "fixed",
      "X-Retry-Count": 3,
    };
    await acceptedOnSave(context, {
      mcp: { servers: { docs: server(headers) } },
      nodeHost: { mcp: { servers: { docs: server(headers) } } },
    });
  });

  test("Configuration and Preset saves refuse a literal key in the other key and header slots the Gateway sends", async (t) => {
    // Finding 1307: memory search, media understanding, speech and Talk providers, web fetch,
    // OpenTelemetry export, skills and the cron webhook carry keys the Gateway sends, most marked
    // sensitive by OpenClaw, but a literal value saved in each and reached the ConfigMap.
    const context = await saveFixture(t);
    const original = await createEmptyConfiguration(context);
    const item = `${context.collection}/${original.id}`;
    const sentinel = `synthetic-gateway-key-${randomUUID()}`;
    const option = (field: string) =>
      `${inline(field)} Make the option value a \${NAME} reference.`;
    const invalidHeaderNames = (field: string, name: string) =>
      `Configuration field ${field} must use valid HTTP header names, not ${JSON.stringify(name)}.`;
    // A literal at `field`, and the refusal that names it.
    const slot = (
      field: string,
      message = literalKey,
      value: OpenClawConfigurationValue = sentinel,
    ): CredentialRefusal => [at(field, value), message(field)];
    const refused: CredentialRefusal[] = [
      slot("/memory/search/remote/apiKey"),
      slot("/agents/entries/main/memory/search/remote/headers/Authorization", literalHeader),
      slot(
        "/memory/search/remote/baseUrl",
        userinfo,
        syntheticCredentialUrl({
          username: "u",
          password: sentinel,
          host: "emb.example.test",
          port: undefined,
        }),
      ),
      [
        {
          tools: {
            media: { models: [{ provider: "openai", headers: { "X-Api-Key": sentinel } }] },
          },
        },
        literalHeader("/tools/media/models/0/headers/X-Api-Key"),
      ],
      [
        at("/tools/media/audio/request/auth", { mode: "authorization-bearer", token: sentinel }),
        literalKey("/tools/media/audio/request/auth/token"),
      ],
      slot(
        "/tools/media/image/models/0/request/headers/Authorization",
        literalHeader,
        `Bearer ${sentinel}`,
      ),
      slot("/tts/providers/openai/apiKey"),
      slot("/tts/personas/narrator/providers/elevenlabs/apiKey"),
      slot("/agents/entries/main/tts/providers/openai/apiKey"),
      slot("/talk/providers/openai/apiKey"),
      slot("/talk/realtime/providers/openai/apiKey", literalKey, 12345),
      slot("/tools/web/fetch/headers/Authorization", literalHeader, `Bearer ${sentinel}`),
      slot("/diagnostics/otel/headers/x-api-key", literalHeader),
      slot("/skills/entries/weather/apiKey"),
      slot("/cron/webhookToken"),
      // Media query options carry a provider's key; a camelCase name is matched by its words.
      slot("/tools/media/models/0/providerOptions/google/key", option),
      slot("/tools/media/audio/providerOptions/deepgram/accessToken", option),
      // A name that only starts like a token count still names a key.
      slot("/tools/media/models/0/providerOptions/google/max_tokens_key", option),
      slot("/tools/media/video/headers/Authorization", literalHeader),
      slot("/gateway/remote/edgeAuth/CF-Access-Client-Secret", literalHeader),
      // A header name no HTTP client sends would hide a literal from the credential rule.
      [
        at("/memory/search/remote/headers/Authorization ", `Bearer ${sentinel}`),
        invalidHeaderNames("/memory/search/remote/headers", "Authorization…"),
      ],
      [
        at("/mcp/servers/docs", {
          url: "https://mcp.example.test",
          headers: { "X-Api-Key\t": sentinel },
        }),
        invalidHeaderNames("/mcp/servers/docs/headers", "X-Api-Key…"),
      ],
    ];
    for (const [values, message] of refused) {
      await t.test(`refuses ${message.split(" ")[2]}`, async () => {
        await refusedOnSave(context, values, message, { item, sentinel });
      });
    }
    // A Preset option name is matched as the text around its variable, as a header name is.
    await t.test("refuses a Preset option name around a variable at save", async () => {
      const field = "/tools/media/models/0/providerOptions/google/api_key{{ vars.suffix }}";
      const response = await savePreset(context, {
        variables: { suffix: { type: "string" } },
        configuration: { values: at(field, sentinel) },
      });
      assertRefused(response, option(field), { label: field, sentinel });
    });
    await assertNoCredentialWrite(context, original);

    // `${NAME}` and SecretRef references, and headers that name no credential, still save.
    const headers = {
      Authorization: "Bearer ${EMBED_TOKEN}",
      "X-Api-Key": "${EMBED_KEY}",
      Accept: "application/json",
    };
    await acceptedOnSave(context, {
      memory: {
        search: {
          remote: { baseUrl: "https://emb.example.test/v1", apiKey: "${EMBED_KEY}", headers },
        },
      },
      agents: {
        entries: {
          main: {
            memory: { search: { remote: { apiKey: environmentReference("EMBED_KEY") } } },
            tts: { providers: { openai: { apiKey: "${TTS_KEY}" } } },
          },
        },
      },
      tools: {
        media: {
          models: [{ provider: "openai", model: "gpt-5", headers }],
          audio: {
            request: { auth: { mode: "authorization-bearer", token: "${MEDIA_TOKEN}" } },
            providerOptions: {
              deepgram: { model: "nova-3", smart_format: true, key: "${DG_KEY}" },
              openai: { max_tokens: 4096, maxOutputTokens: 512 },
              // A count in each word the rule lists, singular or plural, names no credential.
              vllm: {
                min_tokens: 1,
                num_tokens: 2,
                total_tokens: 3,
                context_tokens: 4,
                input_tokens: 5,
                max_completion_tokens: 6,
                max_token: 7,
              },
            },
          },
          image: { models: [{ request: { headers } }] },
        },
        web: {
          fetch: { headers: { Authorization: "Bearer ${FETCH_TOKEN}", "User-Agent": "oce" } },
        },
      },
      tts: {
        providers: { openai: { apiKey: environmentReference("TTS_KEY"), voice: "alloy" } },
        personas: { narrator: { providers: { elevenlabs: { apiKey: "${ELEVENLABS_API_KEY}" } } } },
      },
      talk: {
        providers: { openai: { apiKey: "${TALK_KEY}" } },
        realtime: { providers: { openai: { apiKey: environmentReference("TALK_KEY") } } },
      },
      diagnostics: { otel: { headers: { "x-api-key": "${OTEL_KEY}", "x-tenant": "oce" } } },
      skills: { entries: { weather: { apiKey: environmentReference("WEATHER_KEY") } } },
      cron: { webhookToken: "${CRON_WEBHOOK_TOKEN}" },
      gateway: {
        remote: {
          edgeAuth: {
            "CF-Access-Client-Id": "oce.access",
            "CF-Access-Client-Secret": "${CF_SECRET}",
          },
        },
      },
    });
  });

  test("Configuration and Preset saves refuse a literal secret in the other slots OpenClaw marks sensitive", async (t) => {
    // Finding 1309: Gateway and hooks tokens, sandbox SSH keys, storage passphrases, and the secret
    // settings of channels and plugins (`webSearch.apiKey`) saved as literals and reached the
    // ConfigMap that Namespace members read. Channel and plugin keys are matched as OpenClaw
    // matches plugin-owned fields, plus the fields bundled manifests mark sensitive.
    const context = await saveFixture(t);
    const original = await createEmptyConfiguration(context);
    const item = `${context.collection}/${original.id}`;
    const sentinel = `synthetic-sensitive-slot-${randomUUID()}`;
    const slot = (
      field: string,
      message = literalKey,
      value: OpenClawConfigurationValue = sentinel,
    ): CredentialRefusal => [at(field, value), message(field)];
    // A channel setting is named as the channel rules name it, `channels.telegram.botToken`
    // (finding 2517).
    const channelLiteral = (field: string) =>
      referenceFormRefusal(field.slice(1).replaceAll("/", "."), "inline");
    const tokenUrl = `https://chat.example.test/?token=${sentinel}`;
    const refused: CredentialRefusal[] = [
      // Slots the pinned OpenClaw schema registers sensitive.
      slot("/gateway/auth/token"),
      // The Gateway password keeps its own message, which names the reference Compute fills.
      [at("/gateway/auth/password", sentinel), gatewayPassword],
      slot("/gateway/remote/token"),
      slot("/gateway/remote/password"),
      slot("/gateway/controlUi/github/token"),
      slot("/hooks/token"),
      slot("/hooks/gmail/pushToken"),
      slot("/agents/defaults/sandbox/ssh/identityData"),
      slot("/agents/entries/main/sandbox/ssh/certificateData"),
      slot("/agents/defaults/sandbox/ssh/knownHostsData"),
      slot("/storage/locations/backup/encryption/passphrase"),
      // Channel settings: a token, an account's password and an inline service account.
      slot("/channels/telegram/botToken", channelLiteral),
      slot("/channels/matrix/accounts/work/password", channelLiteral),
      slot("/channels/googlechat/serviceAccount", channelLiteral, { private_key: sentinel }),
      // A field only the channel's manifest marks sensitive: a URL that carries a token.
      slot("/channels/synology-chat/incomingUrl", channelLiteral, tokenUrl),
      slot("/channels/synology-chat/accounts/ops/webhookUrl", channelLiteral, tokenUrl),
      slot("/channels/synology-chat/webhookUrl", channelLiteral, tokenUrl),
      slot("/channels/synology-chat/accounts/ops/incomingUrl", channelLiteral, tokenUrl),
      // Each word of the rule: a secret, an encryption key, a service account reference.
      slot("/channels/line/channelSecret", channelLiteral),
      slot("/channels/feishu/encryptKey", channelLiteral),
      slot("/channels/googlechat/serviceAccountRef", channelLiteral),
      // Two literals in one channel: the first in the document is named.
      [
        { channels: { telegram: { botToken: sentinel, webhookSecret: sentinel } } },
        channelLiteral("/channels/telegram/botToken"),
      ],
      // Plugin settings: a key, an account's password, a list entry, a field only the manifest
      // marks sensitive and a headers map.
      slot("/plugins/entries/brave/config/webSearch/apiKey"),
      slot("/plugins/entries/imap/config/accounts/work/password"),
      [
        at("/plugins/entries/memory-lancedb/config/embedding/apiKeys", ["${EMBED_KEY}", sentinel]),
        literalKey("/plugins/entries/memory-lancedb/config/embedding/apiKeys/1"),
      ],
      slot("/plugins/entries/voice-call/config/telnyx/publicKey"),
      slot(
        "/plugins/entries/codex/config/appServer/headers/Authorization",
        literalHeader,
        `Bearer ${sentinel}`,
      ),
      // A snake_case API key, a private key, and a token whose name starts with "file".
      slot("/plugins/entries/tavily/config/api_key"),
      slot("/plugins/entries/github/config/app/privateKey"),
      slot("/plugins/entries/dropbox/config/fileAccessToken"),
      // A Gateway password that is not a whole `${NAME}` reference or an env reference with an id.
      ...[
        `\${OPENCLAW_GATEWAY_PASSWORD}${sentinel}`,
        "${9GATEWAY_PASSWORD}",
        { source: "env", value: sentinel },
      ].map((password): CredentialRefusal => [
        at("/gateway/auth/password", password),
        gatewayPassword,
      ]),
    ];
    for (const [index, [values, message]] of refused.entries()) {
      await t.test(`refuses ${index}: ${message.split(" ")[2]}`, async () => {
        await refusedOnSave(context, values, message, { item, sentinel });
      });
    }
    // A Preset variable that fills a whole secret renders as its own text, a literal: the Preset
    // must name a reference instead (a SecretRef whose `id` waits on a variable).
    const variable = await savePreset(context, {
      variables: { token: { type: "string" } },
      configuration: { values: { channels: { telegram: { botToken: "{{ vars.token }}" } } } },
    });
    assertRefused(variable, channelLiteral("/channels/telegram/botToken"));
    await assertNoCredentialWrite(context, original);

    // `${NAME}` and SecretRef references still save, and so do settings the rule leaves alone:
    // where a credential is read from (`secretFile`), a channel map key that reads like one, a
    // boolean, a hook mapping's routing key, an unencrypted storage location, and an environment
    // map, which keeps the rules every environment map has.
    await acceptedOnSave(context, {
      gateway: {
        auth: { mode: "password", password: "${OPENCLAW_GATEWAY_PASSWORD}" },
        remote: { token: environmentReference("REMOTE_GATEWAY_TOKEN") },
        controlUi: { github: { token: "${CONTROL_UI_GITHUB_TOKEN}" } },
      },
      hooks: {
        token: "${HOOKS_TOKEN}",
        gmail: { pushToken: "${GMAIL_PUSH_TOKEN}" },
        mappings: [{ match: { path: "gmail" }, sessionKey: "hook:gmail:{{messages[0].id}}" }],
      },
      agents: {
        defaults: { sandbox: { ssh: { identityData: environmentReference("SANDBOX_SSH_KEY") } } },
      },
      storage: {
        locations: {
          backup: { encryption: { passphrase: "${BACKUP_PASSPHRASE}" } },
          scratch: { encryption: "none" },
        },
      },
      channels: {
        telegram: {
          enabled: false,
          botToken: "${TELEGRAM_BOT_TOKEN}",
          accounts: { work: { botToken: environmentReference("TELEGRAM_WORK_BOT_TOKEN") } },
        },
        line: { enabled: false, secretFile: "/run/secrets/line-channel-secret" },
        googlechat: {
          enabled: false,
          serviceAccount: environmentReference("GOOGLECHAT_SERVICE_ACCOUNT"),
          serviceAccountEmail: "chat-bot@example.iam.gserviceaccount.com",
        },
        slack: { enabled: false, channels: { "secret-launch": { requireMention: true } } },
      },
      plugins: {
        entries: {
          brave: { config: { webSearch: { apiKey: "${BRAVE_API_KEY}" } } },
          firecrawl: {
            config: { webFetch: { apiKey: environmentReference("FIRECRAWL_API_KEY") } },
          },
          "voice-call": { config: { telnyx: { publicKey: "${TELNYX_PUBLIC_KEY}" } } },
          "visitor-access": { config: { requireToken: true } },
          // Where a secret is read from, and a name that only starts with "token".
          "secret-reader": {
            config: {
              secretPath: "/run/secrets/reader",
              secretsDir: "/run/secrets",
              apiKeyEnv: "READER_API_KEY",
              tokenizer: "o200k_base",
            },
          },
          acpx: {
            config: {
              mcpServers: { docs: { command: "docs-mcp", env: { DOCS_API_TOKEN: "env-value" } } },
            },
          },
        },
      },
    });
  });

  test("a credential reference that is not the whole value is refused with a message naming its form", async (t) => {
    // Finding 2493: a bound Slack token written as `$NAME`, with a fallback or inside other text
    // passed the channel binding rule and fell to the inline-credential message, which reads as if
    // the reference were a credential. The refusal stays; its message names the form and what to
    // write, and never the text around the reference or the fallback, which may hold the token.
    const context = await saveFixture(t);
    const original = await createEmptyConfiguration(context);
    const item = `${context.collection}/${original.id}`;
    const sentinel = `synthetic-${randomUUID()}`;
    // The message names the setting as the channel binding rules do (finding 2503).
    const shorthand = (path: string) => referenceFormRefusal(path, "shorthand");
    const fallback = (path: string) => referenceFormRefusal(path, "fallback");
    const otherText = (path: string) => referenceFormRefusal(path, "otherText");
    const slack = (botToken: string) => ({ channels: { slack: { enabled: true, botToken } } });
    const bot = "channels.slack.botToken";
    const refused: CredentialRefusal[] = [
      [slack("$SLACK_BOT_TOKEN"), shorthand(bot)],
      [slack("${SLACK_BOT_TOKEN:-}"), fallback(bot)],
      [slack(`\${SLACK_BOT_TOKEN:-${sentinel}}`), fallback(bot)],
      [slack(`${sentinel}-\${SLACK_BOT_TOKEN}`), otherText(bot)],
      [slack("xoxb-${SLACK_BOT_TOKEN}"), otherText(bot)],
      // A line break or a second reference is not text, but still not the whole value (finding 2503).
      [slack("${SLACK_BOT_TOKEN}\n"), otherText(bot)],
      [slack("${SLACK_BOT_TOKEN}${SLACK_APP_TOKEN}"), otherText(bot)],
      // Any key slot: a plugin's API key and the Gateway's remote token.
      [
        {
          plugins: {
            entries: { brave: { config: { webSearch: { apiKey: "Bearer ${BRAVE_KEY}" } } } },
          },
        },
        otherText("plugins.entries.brave.config.webSearch.apiKey"),
      ],
      [{ gateway: { remote: { token: "$REMOTE_TOKEN" } } }, shorthand("gateway.remote.token")],
      // A plugin setting OpenClaw does not resolve as a secret input keeps `$NAME` as written: a
      // field only the manifest marks sensitive, and a key of a plugin that declares none
      // (finding 3044).
      [
        {
          plugins: {
            entries: { "voice-call": { config: { telnyx: { publicKey: "$TELNYX_PUBLIC_KEY" } } } },
          },
        },
        shorthand("plugins.entries.voice-call.config.telnyx.publicKey"),
      ],
      [
        { plugins: { entries: { reader: { config: { apiKey: "$READER_API_KEY" } } } } },
        shorthand("plugins.entries.reader.config.apiKey"),
      ],
      // A secret input holds one string: OpenClaw reads no list entry under it.
      [
        {
          plugins: { entries: { imap: { config: { accounts: { work: { password: ["$PW"] } } } } } },
        },
        shorthand("plugins.entries.imap.config.accounts.work.password.0"),
      ],
      // voice-call declares its TTS providers' keys, not those of a persona's providers.
      [
        {
          plugins: {
            entries: {
              "voice-call": {
                config: {
                  tts: { personas: { calm: { providers: { openai: { apiKey: "$TTS_KEY" } } } } },
                },
              },
            },
          },
        },
        shorthand("plugins.entries.voice-call.config.tts.personas.calm.providers.openai.apiKey"),
      ],
      // An escape renders literal text, so it is a literal credential, with that message. So is a
      // `$` before a name the runtime does not read as one (finding 2517).
      [slack("$${SLACK_BOT_TOKEN}"), referenceFormRefusal(bot, "inline")],
      [slack(`$xoxb${sentinel}`), referenceFormRefusal(bot, "inline")],
    ];
    for (const [values, message] of refused) {
      await refusedOnSave(context, values, message, { item, sentinel });
    }
    await assertNoCredentialWrite(context, original);
  });

  test("a plugin secret input saves OpenClaw's whole $NAME shorthand as a reference", async (t) => {
    // Finding 3044: OpenClaw resolves a plugin's secret inputs (manifest `secretInputs`, web search
    // and fetch API keys) as SecretRefs and reads a whole `$NAME` there, trimmed, as the environment
    // SecretRef to NAME, as it reads `${NAME}`. The save called it a credential value inline.
    const context = await saveFixture(t);
    await acceptedOnSave(context, {
      plugins: {
        entries: {
          codex: {
            config: {
              appServer: {
                authToken: "$APP_SERVER_TOKEN",
                headers: { Authorization: "$APP_SERVER_TOKEN" },
              },
            },
          },
          google: {
            config: {
              webSearch: { apiKey: "$GOOGLE_SEARCH_KEY", headers: { "X-Api-Key": "$KEY" } },
            },
          },
          brave: { config: { webSearch: { apiKey: " $BRAVE_API_KEY " } } },
          firecrawl: { config: { webFetch: { apiKey: "$FIRECRAWL_API_KEY" } } },
          imap: { config: { accounts: { work: { password: "$IMAP_WORK_PASSWORD" } } } },
          "voice-call": {
            config: {
              twilio: { authToken: "$TWILIO_AUTH_TOKEN" },
              numbers: { main: { tts: { providers: { openai: { apiKey: "$TTS_KEY" } } } } },
            },
          },
        },
      },
    });
    // Only the shorthand OpenClaw reads: an uppercase name, the whole value but for spaces.
    const sentinel = `synthetic-${randomUUID()}`;
    const brave = (apiKey: string) => ({
      plugins: { entries: { brave: { config: { webSearch: { apiKey } } } } },
    });
    const literal = literalKey("/plugins/entries/brave/config/webSearch/apiKey");
    for (const apiKey of [
      `$${sentinel}`,
      "$brave_api_key",
      `$BRAVE_API_KEY ${sentinel}`,
      "Bearer $BRAVE_API_KEY",
    ]) {
      await refusedOnSave(context, brave(apiKey), literal, { sentinel });
    }
  });
}
