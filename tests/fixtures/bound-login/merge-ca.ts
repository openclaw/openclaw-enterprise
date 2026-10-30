/** Init-only CA concatenation, after the chart's existing CA assembly. */
import fs from "node:fs";

const original = process.env.BOUND_LOGIN_ORIGINAL_CA;
const prior = original ? fs.readFileSync(original) : Buffer.alloc(0);
const fixture = fs.readFileSync("/bound-login-ca/ca.crt");
if (!fixture.includes("-----BEGIN CERTIFICATE-----")) {
  throw Error("Missing fixture CA");
}
fs.writeFileSync(
  "/bound-login-combined/ca.crt",
  Buffer.concat([prior, Buffer.from("\n"), fixture]),
  { mode: 0o444 },
);
