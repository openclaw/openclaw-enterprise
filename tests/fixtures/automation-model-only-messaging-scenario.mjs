import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  nativeToolValue as outputValue,
  declaredFunction as declared,
} from "./automation-model-only-dispatch-scenarios.mjs";

const channel = "CLOCAL001";
const port = 18802;
const markerFor = (nonce, phase) => `OCE_MESSAGE_${phase.toUpperCase()}_${nonce}`;
const tokenFor = (nonce) => ["xoxb", "111", "222", nonce.replaceAll("-", "")].join("-");

export function configure(base, { nonce }) {
  return {
    ...base,
    plugins: {
      ...base.plugins,
      ...(base.plugins?.allow ? { allow: [...new Set([...base.plugins.allow, "slack"])] } : {}),
      entries: { ...base.plugins?.entries, slack: { enabled: true } },
    },
    channels: {
      ...base.channels,
      slack: {
        enabled: true,
        mode: "http",
        botToken: tokenFor(nonce),
        signingSecret: `synthetic-signing-${nonce}`,
        dmPolicy: "disabled",
        groupPolicy: "allowlist",
        channels: { [channel]: { requireMention: false } },
      },
    },
  };
}

export function environment() {
  // The bundled Slack client supports this API-origin override. The fixture
  // Namespace/container has no external egress and uses generated dummy values.
  return { SLACK_API_URL: `http://127.0.0.1:${port}/api/` };
}

export async function startSink({ nonce }) {
  const requests = [];
  const messages = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 524288) {
        req.destroy();
      }
    });
    req.on("end", () => {
      const reply = (value, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.method !== "POST" || req.headers.authorization !== `Bearer ${tokenFor(nonce)}`) {
        reply({ ok: false, error: "invalid_auth" }, 401);
        return;
      }
      let input;
      try {
        input = req.headers["content-type"]?.includes("application/json")
          ? JSON.parse(body)
          : Object.fromEntries(new URLSearchParams(body));
      } catch {
        reply({ ok: false, error: "invalid_arguments" }, 400);
        return;
      }
      const method = req.url?.replace(/^\/api\//u, "");
      requests.push({ method });
      if (method === "auth.test") {
        reply({
          ok: true,
          team: "Local fixture",
          team_id: "TLOCAL001",
          user: "fixture-bot",
          user_id: "ULOCAL001",
          bot_id: "BLOCAL001",
          is_enterprise_install: false,
        });
      } else if (method === "conversations.info" && input.channel === channel) {
        reply({
          ok: true,
          channel: {
            id: channel,
            name: "local-fixture",
            is_channel: true,
            is_member: true,
            is_private: false,
          },
        });
      } else if (method === "users.info" && input.user === "ULOCAL001") {
        reply({
          ok: true,
          user: {
            id: "ULOCAL001",
            name: "fixture-bot",
            is_bot: true,
            profile: { bot_id: "BLOCAL001", api_app_id: "ALOCAL001" },
          },
        });
      } else if (method === "chat.postMessage") {
        // Record the actual transport attempt even if its target is invalid.
        // Only this endpoint creates a message in the local service fixture.
        messages.push({ channel: input.channel, text: input.text });
        if (input.channel !== channel || typeof input.text !== "string") {
          reply({ ok: false, error: "channel_not_found" });
          return;
        }
        const ts = `1700000000.${String(messages.length).padStart(6, "0")}`;
        reply({
          ok: true,
          channel,
          ts,
          message: { type: "message", text: input.text, ts, user: "ULOCAL001" },
        });
      } else {
        reply({ ok: false, error: "method_not_supported" }, 404);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    snapshot: () => ({ requests: structuredClone(requests), messages: structuredClone(messages) }),
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const call = (name, args) => ({
  call: { type: "function_call", name, arguments: JSON.stringify(args) },
});

export function createProviderStrategy({ nonce }) {
  let stage = "initial";
  let outerTool;
  let targetId;
  function sendArgs(phase) {
    return {
      action: "send",
      channel: "slack",
      target: `channel:${channel}`,
      message: markerFor(nonce, phase),
    };
  }
  function checkSchema(schema) {
    for (const name of Object.keys(sendArgs("positive"))) {
      assert.ok(schema?.properties?.[name], `the actual message schema must declare ${name}`);
    }
    assert.ok((schema.required ?? []).every((name) => Object.hasOwn(sendArgs("positive"), name)));
    assert.ok(
      schema.properties.action.enum?.includes("send"),
      "the actual message declaration must support send",
    );
  }
  function sendCall(phase) {
    return outerTool === "message"
      ? call(outerTool, sendArgs(phase))
      : call(outerTool, { id: targetId, args: sendArgs(phase) });
  }
  return {
    plan({ phase, tools, output }) {
      if (phase === "negative") {
        assert.ok(outerTool);
        if (!output) {
          return sendCall(phase);
        }
        assert.match(
          JSON.stringify(output.output),
          /unknown tool|tool.{0,80}(?:not found|not available|unavailable|disabled)|unsupported.{0,40}(?:tool|call)|unrecognized.{0,40}tool|no tool/iu,
        );
        return {
          complete: true,
          summary: { family: "messaging", outerTool, targetTool: "message" },
        };
      }
      assert.equal(phase, "positive");
      if (stage === "initial") {
        assert.equal(output, undefined);
        if (tools.some((tool) => tool.name === "message")) {
          const tool = declared(tools, "message", ["action", "channel", "target", "message"]);
          checkSchema(tool.parameters);
          outerTool = tool.name;
          stage = "sent";
          return sendCall(phase);
        }
        declared(tools, "tool_search", ["query"]);
        declared(tools, "tool_describe", ["id"]);
        declared(tools, "dispatch_action", ["id", "args"]);
        stage = "searched";
        return call("tool_search", { query: "message", limit: 1 });
      }
      assert.ok(output);
      if (stage === "searched") {
        const found = outputValue(output);
        assert.ok(Array.isArray(found));
        const matches = found.filter(
          (entry) => entry.name === "message" && entry.source === "openclaw",
        );
        assert.equal(matches.length, 1);
        assert.equal(typeof matches[0].id, "string");
        targetId = matches[0].id;
        stage = "described";
        return call("tool_describe", { id: targetId });
      }
      if (stage === "described") {
        const description = outputValue(output);
        assert.equal(description.id, targetId);
        assert.equal(description.name, "message");
        checkSchema(description.parameters);
        outerTool = "dispatch_action";
        stage = "sent";
        return sendCall(phase);
      }
      assert.equal(stage, "sent");
      // Native output is retained by the provider. The local sink, not its text,
      // independently decides whether the positive send actually reached transport.
      stage = "complete";
      return { complete: true, summary: { family: "messaging", outerTool, targetTool: "message" } };
    },
  };
}

export async function verify({ nonce, sink }) {
  assert.ok(sink, "messaging proof requires its independent local sink");
  const observed = sink.snapshot();
  assert.equal(
    observed.messages.length,
    1,
    "only the allowed positive call may reach the messaging sink",
  );
  const positive = observed.messages.filter(
    (message) => message.text === markerFor(nonce, "positive"),
  );
  assert.equal(positive.length, 1, "ordinary messaging must create exactly one local message");
  assert.equal(positive[0].channel, channel);
  assert.equal(
    observed.messages.filter(
      (message) =>
        typeof message.text === "string" && message.text.includes(markerFor(nonce, "negative")),
    ).length,
    0,
    "empty-cap scheduling must not reach the local messaging sink",
  );
  return {
    family: "messaging",
    positiveEffectVerified: true,
    negativeEffectAbsent: true,
    sink: "local Slack-protocol fixture",
    realSlackService: false,
    positiveTransportMessages: positive.length,
    exactChannelVerified: true,
    negativeTransportMessages: 0,
    methodsObserved: [...new Set(observed.requests.map((request) => request.method))],
  };
}
