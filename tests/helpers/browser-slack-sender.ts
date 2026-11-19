import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord } from "../../packages/utils/src/objects.ts";

/** The external browser coordinator sends once; Slack reads and native records prove delivery. */
export function browserSlackSender(input: {
  directory: string;
  workspaceId: string;
  channelId: string;
  appId: string;
  senderUserId: string;
}) {
  return async (testText: string): Promise<{ channel: string; ts: string }> => {
    assert.ok((await stat(input.directory)).isDirectory());
    const requestId = `slack-message-${randomUUID()}`;
    const temporary = join(input.directory, `${requestId}.json`);
    await writeFile(
      temporary,
      JSON.stringify(
        {
          requestId,
          operation: "send_human_message",
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          appId: input.appId,
          channelUrl: `https://app.slack.com/client/${input.workspaceId}/${input.channelId}`,
          testText,
          expectedResponse:
            "Send this exact message once as the signed-in human. Return status completed, channelId, senderUserId, sentMessageTs and its permalink. Observe the bot reply without sending again.",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await rename(temporary, join(input.directory, "browser-request.json"));
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      let response: Record<string, unknown> | undefined;
      try {
        response = asRecord(
          JSON.parse(await readFile(join(input.directory, "browser-response.json"), "utf8")),
        );
      } catch {
        /* The coordinator has not published this response yet. */
      }
      if (response?.requestId === requestId) {
        assert.equal(
          response.status,
          "completed",
          "the browser coordinator must confirm one actual human message",
        );
        assert.equal(response.channelId, input.channelId);
        assert.equal(response.senderUserId, input.senderUserId);
        assert.equal(typeof response.sentMessageTs, "string");
        assert.match(response.sentMessageTs as string, /^\d+\.\d+$/);
        return { channel: input.channelId, ts: response.sentMessageTs as string };
      }
      await delay(1_000);
    }
    throw new Error(
      "The authorized browser sender did not confirm the single Slack message before the test deadline.",
    );
  };
}
