import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { temporaryDirectorySync } from "../helpers/temporary-directory.ts";
import { chartTooling, helmTemplate, parseProductionChart } from "../helpers/production-chart.ts";

type Data = Record<string, unknown>;

function record(value: unknown): Data {
  assert.ok(isRecord(value));
  return value;
}

function isRecord(value: unknown): value is Data {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function occurrences(value: unknown, expected: string): number {
  if (value === expected) {
    return 1;
  }
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + occurrences(item, expected), 0);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce<number>(
      (count, item) => count + occurrences(item, expected),
      0,
    );
  }
  return 0;
}

const tooling = await chartTooling();

test(
  "production Keycloak example renders an attached-only pilot through the chart",
  tooling,
  async (t) => {
    const directory = temporaryDirectorySync(t, "oce-keycloak-profile-");
    const rendered = spawnSync(
      process.execPath,
      [
        "scripts/render-installation-profile.ts",
        "--profile",
        "openclaw",
        "--input",
        "deploy/examples/production/keycloak-profile-input.json",
        "--out-dir",
        directory,
      ],
      { encoding: "utf8" },
    );
    assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
    const preflight = JSON.parse(readFileSync(join(directory, "preflight.json"), "utf8"));
    assert.equal(preflight.ok, true);
    assert.deepEqual(preflight.errors, []);
    assert.deepEqual(preflight.warnings, []);

    const documents = (await parseProductionChart(helmTemplate({ directory }))).map(record);
    const api = documents.find(
      (document) =>
        document.kind === "Deployment" &&
        record(document.metadata).name === "openclaw-enterprise-api",
    );
    assert.ok(api, "the API Deployment must render");
    const pod = record(record(record(api.spec).template).spec);
    const apiContainer = array(pod.containers)
      .map(record)
      .find((container) => container.name === "api");
    assert.ok(apiContainer, "the API container must render");
    const env = array(apiContainer.env).map(record);
    const enrollment = env.find((entry) => entry.name === "OCC_AUTH_OIDC_ENROLLMENT");
    assert.ok(enrollment && typeof enrollment.value === "string");
    assert.deepEqual(JSON.parse(enrollment.value), {
      additionalScopes: [],
      admission: { anyOf: ["/oce-pilot"], groupsClaim: "groups" },
      createAccount: { enabled: false, requireVerifiedEmail: true },
      groupIds: [],
    });
    assert.equal(
      env.find((entry) => entry.name === "OCC_AUTH_OIDC_ISSUER")?.value,
      "https://sso.example.com/realms/acme",
    );
    for (const [name, key] of [
      ["OCC_AUTH_OIDC_CLIENT_ID", "client-id"],
      ["OCC_AUTH_OIDC_CLIENT_SECRET", "client-secret"],
    ]) {
      const entry = env.find((item) => item.name === name);
      assert.ok(entry, `${name} must be configured on the API container`);
      const reference = record(record(entry.valueFrom).secretKeyRef);
      assert.equal(reference.name, "occ-oidc-login");
      assert.equal(reference.key, key);
    }
    assert.equal(
      occurrences(documents, "occ-oidc-login"),
      2,
      "only the two API environment variables may consume the OIDC credential Secret",
    );
  },
);
