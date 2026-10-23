// Representative API schema for isolated, simulated Storybook scenarios.
export default {
  type: "object",
  required: ["additions"],
  properties: {
    additions: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "binary", "host", "ports"],
        properties: {
          id: { type: "string", title: "Rule ID", pattern: "^[a-z][a-z0-9-]{0,47}$" },
          binary: {
            type: "string",
            title: "Executable path",
            description: "Absolute path of the executable receiving access.",
            minLength: 2,
            maxLength: 512,
            pattern: "^/[^\\s\\x00-\\x1f]+$",
          },
          host: {
            type: "string",
            title: "Destination hostname",
            description:
              "DNS hostname or permitted single-label wildcard. Grants allow access; omitted destinations stay denied.",
            minLength: 1,
            maxLength: 253,
            pattern: "^(\\*\\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$",
          },
          ports: {
            type: "array",
            items: {
              type: "object",
              required: ["from", "to"],
              properties: {
                from: { type: "integer", title: "Start port", minimum: 1, maximum: 65535 },
                to: { type: "integer", title: "End port", minimum: 1, maximum: 65535 },
              },
              additionalProperties: false,
            },
            title: "Port ranges",
            minItems: 1,
            maxItems: 16,
          },
        },
        additionalProperties: false,
      },
      title: "Network rules",
      maxItems: 32,
    },
  },
  additionalProperties: false,
};
