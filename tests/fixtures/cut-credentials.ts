import assert from "node:assert/strict";

import { syntheticCredentialUrl } from "./synthetic-credential-url.mjs";

// Made-up credentials in each shape the CI redaction masks, for a producer's cut that lands
// inside one. `text` is what a log prints; `secret` is the part that must not be published.
export const registeredCutSecret = "Zml4dHVyZVJlZ2lzdGVyZWQtMDA0Mg";
const urlPassword = "FixturePass0042abcd";
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlLXVzZXIifQ.Zml4dHVyZS1zaWduYXR1cmUtdmFsdWU";
const keyBody = [
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCZml4dHVyZUJvZHlMaW5lT25lMDA0Mg",
  "Zml4dHVyZUJvZHlMaW5lVHdvMDA0MkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC",
];
const keyData = Buffer.from("fixture client key data 0042 ".repeat(8)).toString("base64");

export const cutCredentials = [
  { name: "a JWT", text: jwt, secret: jwt },
  {
    name: "a URL password",
    text: syntheticCredentialUrl({
      protocol: "postgresql",
      username: "fixture-user",
      password: urlPassword,
      host: "db.example.test",
      port: 5432,
      pathname: "/app",
    }),
    secret: urlPassword,
  },
  {
    name: "a key=value credential",
    text: "password=FixturePw-0042-value",
    secret: "FixturePw-0042-value",
  },
  {
    name: "a private key block",
    text: ["-----BEGIN PRIVATE KEY-----", ...keyBody, "-----END PRIVATE KEY-----"].join("\n"),
    secret: keyBody.join("\n"),
  },
  { name: "a client-key-data value", text: `client-key-data: ${keyData}`, secret: keyData },
  { name: "a registered secret", text: registeredCutSecret, secret: registeredCutSecret },
];

// Cuts one character in, in the middle, and one character before the end.
export function cutOffsets(text: string) {
  return [1, Math.floor(text.length / 2), text.length - 1];
}

// A value is shown when any 8 of its characters within a line are.
export function assertAbsent(shown: string, value: string, label: string) {
  for (let index = 0; index + 8 <= value.length; index += 1) {
    const piece = value.slice(index, index + 8);
    assert(piece.includes("\n") || !shown.includes(piece), `${label} shows ${piece}`);
  }
}
