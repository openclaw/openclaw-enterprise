import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";

export const nativeAccessCookie = "__Host-occ_agent_access";
// Two Console tabs may bind launches on the same Agent before either redeems.
export function nativeChallengeCookie(intentId: string): string {
  return `__Host-occ_agent_challenge_${intentId}`;
}
export const nativeLandingPath = "/__occ/native-admin/launch";
export const nativeRedemptionPath = "/__occ/native-admin/redeem";

export function browserSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function browserSecretHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validBrowserSecret(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function browserCookie(header: string | undefined, name: string): string | null | undefined {
  const values = (header ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${name}=`));
  if (values.length === 0) {
    return undefined;
  }
  if (values.length !== 1) {
    return null;
  }
  const value = values[0]!.slice(name.length + 1);
  return validBrowserSecret(value) ? value : null;
}

export function hostCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

function scriptValue(value: string): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function bridgeHeaders(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header(
    "content-security-policy",
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-content-type-options", "nosniff");
}

function bridgePage(reply: FastifyReply, script: string): void {
  bridgeHeaders(reply);
  const nonce = browserSecret();
  reply.header(
    "content-security-policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  reply
    .type("text/html; charset=utf-8")
    .send(
      `<!doctype html><html><head><meta name="referrer" content="no-referrer"><title>Open Agent</title></head><body><p id="status">Opening native admin UI…</p><script nonce="${nonce}">${script}</script></body></html>`,
    );
}

export function landingPage(
  reply: FastifyReply,
  consoleOrigin: string,
  intentId: string,
  challenge: string,
): void {
  bridgePage(
    reply,
    `"use strict";
    const parent = window.opener;
    const origin = ${scriptValue(consoleOrigin)};
    const intentId = ${scriptValue(intentId)};
    const timeout = setTimeout(() => { window.opener = null; document.getElementById("status").textContent = "Launch expired. Return to the console and open the Agent again."; window.removeEventListener("message", receive); }, 60000);
    function receive(event) {
      if (event.origin !== origin || event.source !== parent || event.data?.type !== "occ-native-challenge" || event.data.intentId !== intentId) { return; }
      window.removeEventListener("message", receive);
      parent.postMessage({ type: "occ-native-bound", intentId, challenge: ${scriptValue(challenge)} }, origin);
    }
    window.addEventListener("message", receive);
    if (parent) { parent.postMessage({ type: "occ-native-ready", intentId }, origin); }
    else { document.getElementById("status").textContent = "Return to the console and open the Agent again."; }
  `,
  );
}

export function redeemedPage(reply: FastifyReply): void {
  bridgePage(reply, `window.opener = null; window.location.replace("/");`);
}
