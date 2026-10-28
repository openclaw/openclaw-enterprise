#!/usr/local/bin/node
const usage = 'Usage: oce-slack-search "<query>"';
const scopedToken = /^openshell:resolve:env:s[0-9a-f]{64}_SLACK_SEARCH_TOKEN$/;
const messageLink =
  /^https:\/\/(?:[a-z0-9-]+\.)*slack\.com\/archives\/[CG][A-Z0-9]+\/p\d+(?:\?[^\s#]+)?$/;

async function main() {
  const args = process.argv.slice(2);
  const query = args[0]?.trim();
  if (args.length === 1 && query === "--help") {
    console.log(usage);
    return;
  }
  if (args.length !== 1 || !query) {
    throw new Error(usage);
  }
  const token = process.env.SLACK_SEARCH_TOKEN;
  if (!token || !scopedToken.test(token)) {
    throw new Error("Slack search requires the Agent's managed Slack user connection.");
  }

  const response = await fetch("https://slack.com/api/assistant.search.context", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, channel_types: ["public_channel"], content_types: ["messages"] }),
  });
  if (!response.ok) {
    throw new Error(`Slack search returned HTTP ${response.status}.`);
  }
  const result = await response.json().catch(() => null);
  if (result?.ok === false) {
    const code =
      typeof result.error === "string" && /^[a-z_]{1,64}$/.test(result.error)
        ? result.error
        : "unknown_error";
    throw new Error(`Slack search failed (${code}).`);
  }
  if (result?.ok !== true || !Array.isArray(result.results?.messages)) {
    throw new Error("Slack returned an invalid search response.");
  }
  const messages = result.results.messages.map(
    (match: { content?: unknown; permalink?: unknown } | null) => {
      if (
        typeof match?.content !== "string" ||
        typeof match.permalink !== "string" ||
        !messageLink.test(match.permalink)
      ) {
        throw new Error("Slack returned a message without usable content or a Slack permalink.");
      }
      return { text: match.content.slice(0, 1000), permalink: match.permalink };
    },
  );
  console.log(JSON.stringify({ messages }));
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
