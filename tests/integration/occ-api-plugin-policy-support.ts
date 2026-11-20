import assert from "node:assert/strict";

import {
  AgentReadResponse,
  ErrorResponse,
  type CreateAgentBody,
  type ErrorCode,
  type PluginDesiredState,
  type PluginDriver,
  type UpdateAgentBody,
} from "../../packages/contracts/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import {
  checkedInjectedBody,
  createInjectedControllerFixture,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";

export type Controller = {
  fixture: Awaited<ReturnType<typeof createInjectedControllerFixture>>;
  request: FixtureRequest;
};
export type ConfigurationDriver = ReturnType<typeof createTestConfigurationDriver>;
export type ConfiguredController = (options?: {
  configurationDriver?: ConfigurationDriver;
}) => Promise<Controller>;
export type Reply = Awaited<ReturnType<FixtureRequest>>;
export type AgentCreate = Omit<CreateAgentBody, "plugins"> & { plugins?: PluginDesiredState };
export type AgentUpdate = Omit<UpdateAgentBody, "plugins"> & { plugins?: PluginDesiredState };

export const diffsPluginId = "occ-plugin:diffs";
export const linearPluginId = "codex-plugin:linear@openai-curated-remote";
export const diffsSelection = {
  [diffsPluginId]: { enabled: true, toolDefaults: { approval: "none" } },
} satisfies PluginDesiredState;

export function selectPluginDriver({ fixture }: Controller, pluginDriver: PluginDriver): void {
  assert(fixture.controller, "bootstrap must create the controller");
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
}

export function apiError(reply: Reply, status: number, code: ErrorCode, label?: string) {
  const { error } = checkedInjectedBody(reply, status, ErrorResponse);
  assert.equal(error.code, code, `${label ?? "API error"}: ${JSON.stringify(reply.body)}`);
  return error;
}

export function readAgent(reply: Reply) {
  const { data } = checkedInjectedBody(reply, 200, AgentReadResponse);
  assert(!("configurationReadError" in data), JSON.stringify(data));
  return data;
}
