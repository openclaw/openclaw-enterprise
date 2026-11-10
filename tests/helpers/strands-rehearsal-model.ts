import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { text } from "node:stream/consumers";
import type { TestContext } from "node:test";
import { listen } from "../fixtures/repository-credentials/process.mjs";
import { harnessTlsFixture } from "./harness-tls.mjs";

// The caller owns the runtime and must stop it before this fixture's cleanup.
// Only model responses are controlled; the runtime must retain the conversation.
export async function strandsRehearsalModel(t: TestContext) {
  const tls = await harnessTlsFixture(t);
  const { responseEvents } = JSON.parse(
    await readFile(
      new URL("../fixtures/static-egress/codex-responses.json", import.meta.url),
      "utf8",
    ),
  );
  const model = "fixture-model";
  const nonce = randomUUID();
  const credential = "fixture-" + nonce;
  let phase: "before" | "after" = "before";
  let requests = 0;
  let providerError: unknown;
  const answer = () => phase + "-answer-" + nonce;
  const provider = createServer(tls, (req, res) => {
    void (async () => {
      if (req.url !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(await text(req));
      assert.equal(req.headers.authorization, "Bearer " + credential);
      assert.equal(body.model, model);
      assert.ok(JSON.stringify(body.input.at(-1)).includes(phase + "-question"));
      if (phase === "after") {
        assert.ok(
          JSON.stringify(body.input).includes("before-answer-" + nonce),
          "second model request retains the first reply",
        );
      }
      requests++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of responseEvents) {
        res.write(
          "data: " +
            JSON.stringify(event)
              .replaceAll("READY", answer())
              .replaceAll("runtime_probe", "strands_" + requests) +
            "\n\n",
        );
      }
      res.end();
    })().catch((error: unknown) => {
      providerError = error;
      res.destroy();
    });
  });
  let connections = 0;
  provider.on("connection", () => {
    connections++;
  });
  provider.on("tlsClientError", (error) => {
    providerError = error;
  });
  const origin = (await listen(t, provider)).replace("127.0.0.1", "localhost");
  return {
    baseUrl: origin + "/v1",
    model,
    credential,
    rootCertificatePath: tls.rootCertificatePath,
    caBundle: tls.caBundle,
    requests: () => requests,
    connections: () => connections,
    error: () => providerError,
    beginTurn(when: "before" | "after") {
      phase = when;
      return { prompt: when + "-question, reply without tools", answer: answer() };
    },
  };
}
