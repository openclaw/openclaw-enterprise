import { element } from "../dom.mjs";
import {
  isRecord,
  refsEqual,
  providerConfig,
  withProvider,
  field,
  input,
  checkbox,
  refField,
} from "./shared-ui.mjs";

const STANDARD_REFS = {
  msteams: {
    appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
  },
};

function supportTeams(values) {
  if (values?.channels !== undefined && !isRecord(values.channels)) {
    return {
      supported: false,
      reason: "Native channels configuration is not an object.",
      config: values.channels,
    };
  }
  const config = providerConfig(values, "msteams");
  if (config === undefined) {
    return { supported: true, config: {} };
  }
  if (!isRecord(config)) {
    return { supported: false, reason: "Microsoft Teams configuration is not an object.", config };
  }
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    return { supported: false, reason: "Microsoft Teams enabled state is not boolean.", config };
  }
  if (config.account !== undefined || config.accounts !== undefined) {
    return {
      supported: false,
      reason: "Only the default Microsoft Teams account is supported by this editor.",
      config,
    };
  }
  if (
    config.appPassword !== undefined &&
    !refsEqual(config.appPassword, STANDARD_REFS.msteams.appPassword)
  ) {
    return {
      supported: false,
      reason: "Microsoft Teams app password uses a non-standard credential reference.",
      config,
    };
  }
  if (config.appId !== undefined && typeof config.appId !== "string") {
    return { supported: false, reason: "Microsoft Teams application ID is not a string.", config };
  }
  if (config.tenantId !== undefined && typeof config.tenantId !== "string") {
    return { supported: false, reason: "Microsoft Teams tenant ID is not a string.", config };
  }
  if (config.requireMention !== undefined && typeof config.requireMention !== "boolean") {
    return {
      supported: false,
      reason: "Microsoft Teams Require mention value is not boolean.",
      config,
    };
  }
  return { supported: true, config };
}

function updatedTeams(values, body) {
  const current = supportTeams(values).config;
  return withProvider(values, "msteams", {
    ...current,
    enabled: body.querySelector("#msteams-enabled").checked,
    appId: body.querySelector("#msteams-app-id").value.trim(),
    tenantId: body.querySelector("#msteams-tenant-id").value.trim(),
    appPassword: STANDARD_REFS.msteams.appPassword,
    requireMention: body.querySelector("#msteams-require-mention").checked,
  });
}

function appendFields(body, config) {
  body.append(
    field(
      "Application (client) ID",
      input("msteams-app-id", config.appId),
      "The Microsoft Teams application ID.",
    ),
    field(
      "Directory (tenant) ID",
      input("msteams-tenant-id", config.tenantId),
      "The Microsoft Entra tenant ID.",
    ),
    checkbox("msteams-require-mention", "Require a mention", config.requireMention !== false),
    element("h2", {}, "Credential references"),
    element(
      "p",
      { className: "hint" },
      "Fixed unresolved references only. No password value is entered here.",
    ),
    refField("App password reference", config.appPassword ?? STANDARD_REFS.msteams.appPassword),
  );
}

function summary(config) {
  const pieces = [];
  pieces.push(config.appId ? "Application ID set" : "Application ID missing");
  pieces.push(config.tenantId ? "Tenant ID set" : "Tenant ID missing");
  pieces.push(
    isRecord(config.appPassword)
      ? "Credential reference configured"
      : "Default credential reference",
  );
  return pieces.join(" · ");
}

function validate(body) {
  if (
    body.querySelector("#msteams-enabled").checked &&
    (!body.querySelector("#msteams-app-id").value.trim() ||
      !body.querySelector("#msteams-tenant-id").value.trim())
  ) {
    return "Microsoft Teams requires Application ID and Directory tenant ID before enabling.";
  }
  return null;
}

export const teams = {
  id: "msteams",
  name: "Microsoft Teams",
  description: "Application identity and password reference.",
  setup: "Requires operator credential projection and separately configured Bot Framework ingress.",
  plugin: "msteams",
  support: supportTeams,
  updatedValues: updatedTeams,
  appendFields,
  summary,
  validate,
};
