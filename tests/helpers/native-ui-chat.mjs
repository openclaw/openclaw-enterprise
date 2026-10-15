export function textFromFrame(frame) {
  const payload = frame?.payload;
  if (typeof payload === "string") {
    return payload;
  }
  if (Buffer.isBuffer(payload)) {
    return payload.toString("utf8");
  }
  return String(payload ?? "");
}

function messageText(message) {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function terminalAssistantSessionMessage(frameText, marker, prompt) {
  let parsed;
  try {
    parsed = JSON.parse(frameText);
  } catch {
    return false;
  }
  if (parsed?.type !== "event" || parsed.event !== "session.message") {
    return false;
  }
  const message = parsed.payload?.message;
  const text = messageText(message);
  return (
    message?.role === "assistant" &&
    !["toolUse", "error", "aborted"].includes(message.stopReason) &&
    !message.isError &&
    text.includes(marker) &&
    !text.includes(prompt)
  );
}

export async function submitChatTurnWithAssistantProof(
  page,
  marker,
  receivedFrames,
  waitFor,
  authenticate,
) {
  await page.goto(new URL("/new", page.url()).href);
  // Password authentication is held by the native UI in memory. Authenticate
  // after navigation so a reload cannot discard the connection being tested.
  await authenticate?.();
  await waitForStockUi(page);
  const prompt = `Reply with exactly the token on its own line and no other text: ${marker}`;
  const firstFrame = receivedFrames.length;
  const input = page.locator(".agent-chat__composer-combobox > textarea").first();
  await input.waitFor({ state: "visible", timeout: 60_000 });
  await input.fill(prompt);
  await page.getByRole("button", { name: "Start session", exact: true }).click();
  return waitFor("stock UI terminal assistant session.message containing the nonce", () =>
    receivedFrames
      .slice(firstFrame)
      .find((frame) => terminalAssistantSessionMessage(textFromFrame(frame), marker, prompt)),
  );
}

export async function waitForStockUi(page) {
  await page.waitForFunction(
    () =>
      globalThis.customElements.get("openclaw-app") !== undefined &&
      globalThis.document.querySelector("openclaw-app") !== null,
    undefined,
    { timeout: 120_000 },
  );
  await page.waitForFunction(
    () =>
      globalThis
        .getComputedStyle(globalThis.document.documentElement)
        .getPropertyValue("--openclaw-css-ok")
        .trim() === "1",
    undefined,
    { timeout: 60_000 },
  );
  await page.locator("body").waitFor({ state: "visible", timeout: 60_000 });
}
