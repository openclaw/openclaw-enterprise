import { asRecord } from "@openclaw-enterprise/utils";

// Proto3 omits default fields; compare their semantics while retaining every nondefault.
export function wirePolicy(value: unknown, preserveDefaults = false, mapEntries = false): unknown {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) {
    return value.map((item) => wirePolicy(item, preserveDefaults));
  }
  const record = asRecord(value);
  return record
    ? Object.fromEntries(
        Object.entries(record)
          // grpc-js with oneofs adds a virtual "kind": "stringValue" discriminator on decoded
          // google.protobuf.Value. The actual value (including empty, false or zero) remains.
          .filter(
            ([key, item]) =>
              !(
                preserveDefaults &&
                key === "kind" &&
                typeof item === "string" &&
                /^(null|number|string|bool|struct|list)Value$/.test(item) &&
                Object.hasOwn(record, item)
              ),
          )
          .sort(([left], [right]) => left.localeCompare(right, "en"))
          .map(([key, item]) => [
            key,
            wirePolicy(
              item,
              preserveDefaults || key === "config",
              ["network_policies", "network_middlewares", "graphql_persisted_queries"].includes(
                key,
              ),
            ),
          ])
          .filter(
            ([, item]) =>
              preserveDefaults ||
              mapEntries ||
              (item !== false &&
                item !== 0 &&
                item !== "" &&
                item !== undefined &&
                !(Array.isArray(item) && item.length === 0) &&
                !(asRecord(item) && Object.keys(item as object).length === 0)),
          ),
      )
    : value;
}
