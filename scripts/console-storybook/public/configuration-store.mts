import type {
  ConfigurationWire,
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
} from "@openclaw-enterprise/contracts";
import { fixtureError as error, fixtureResponse as response } from "./preview-rules.mts";

// Configuration fixtures include historical invalid settings. JSON is their contract;
// they must not be promoted to validated Controller configuration inputs.
type MutableDocument = { [key: string]: OpenClawConfigurationValue };
type ConfigurationInput = {
  kind: ConfigurationWire["kind"];
  values: MutableDocument;
  secretBindings?: OpenClawConfigurationDocument;
};
export type StoredConfiguration = ConfigurationInput &
  Pick<ConfigurationWire, "id" | "namespaceId" | "generation" | "createdAt">;

type ConfigurationScenario = {
  configurationChangedElsewhere?:
    | boolean
    | {
        afterReads?: number;
        values?: OpenClawConfigurationDocument;
      };
  configurationSaveResponseId?: string;
};

function isDocument(value: unknown): value is MutableDocument {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(isJson)
  );
}

function isJson(value: unknown): value is OpenClawConfigurationValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) ? value.every(isJson) : isDocument(value))
  );
}

export function configurationInput(value: unknown): ConfigurationInput | undefined {
  if (
    !isDocument(value) ||
    value.kind !== "agent" ||
    !isDocument(value.values) ||
    (value.secretBindings !== undefined && !isDocument(value.secretBindings))
  ) {
    return undefined;
  }
  return {
    ...value,
    kind: value.kind,
    values: value.values,
    ...(value.secretBindings === undefined ? {} : { secretBindings: value.secretBindings }),
  };
}

// Another browser's save: objects merge, other JSON values replace.
function isConfigurationObject(
  value: OpenClawConfigurationValue | undefined,
): value is MutableDocument {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeElsewhere(target: MutableDocument, changes: OpenClawConfigurationDocument) {
  for (const [key, value] of Object.entries(changes)) {
    const current = target[key];
    if (isConfigurationObject(value) && isConfigurationObject(current)) {
      mergeElsewhere(current, value);
    } else {
      target[key] = structuredClone(value);
    }
  }
}

export function createConfigurationStore(
  scenario: ConfigurationScenario,
  namespaceId: string,
  createdAt: string,
  nextId: (prefix: string) => string,
) {
  const configs = new Map<string, StoredConfiguration>();
  const configurationReads = new Map<string, number>();
  let configurationChangedElsewhere = false;

  function serve(resource: string, method: string, body: unknown): Response | undefined {
    if (resource === "configurations" && method === "POST") {
      const input = configurationInput(body);
      if (input === undefined) {
        return error(
          400,
          "INVALID_REQUEST",
          "The preview requires agent kind, JSON values and optional object bindings.",
        );
      }
      const saved: StoredConfiguration = {
        ...input,
        id: nextId("cfg"),
        namespaceId,
        generation: 1,
        createdAt,
      };
      configs.set(saved.id, saved);
      return response(saved, 201);
    }
    if (resource.startsWith("configurations/")) {
      const saved = configs.get(resource.split("/")[1] ?? "");
      if (!saved) {
        return error(404);
      }
      if (method === "GET") {
        // Count only reads of an existing Configuration; the competing save occurs once per frame.
        if (scenario.configurationChangedElsewhere && !configurationChangedElsewhere) {
          const changes =
            typeof scenario.configurationChangedElsewhere === "object"
              ? scenario.configurationChangedElsewhere
              : {};
          const reads = configurationReads.get(saved.id) ?? 0;
          if (reads >= (changes.afterReads ?? 1)) {
            configurationChangedElsewhere = true;
            saved.generation += 1;
            mergeElsewhere(saved.values, changes.values ?? {});
          }
          configurationReads.set(saved.id, reads + 1);
        }
        return response(saved);
      }
      if (method === "PATCH") {
        // Validate the resulting shape, retaining Object.assign's partial update and extra keys.
        const patch = objectInput(body);
        if (patch === undefined) {
          return error(
            400,
            "INVALID_REQUEST",
            "The preview requires an object Configuration patch.",
          );
        }
        const result = { ...saved, ...patch };
        if (configurationInput(result) === undefined) {
          return error(
            400,
            "INVALID_REQUEST",
            "The preview requires agent kind, JSON values and optional object bindings.",
          );
        }
        // The route also consumes these fields on later reads and saves.
        if (
          ("id" in patch && typeof patch.id !== "string") ||
          ("namespaceId" in patch && typeof patch.namespaceId !== "string") ||
          ("createdAt" in patch && typeof patch.createdAt !== "string")
        ) {
          return error(
            400,
            "INVALID_REQUEST",
            "The preview requires string Configuration metadata.",
          );
        }
        Object.assign(saved, patch, { generation: saved.generation + 1 });
        return response({ ...saved, id: scenario.configurationSaveResponseId ?? saved.id });
      }
    }
    return undefined;
  }
  return { configs, serve };
}

// Body fields not consumed by a route are carried through without claiming their model type.
function objectInput(value: unknown): object | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value;
}
