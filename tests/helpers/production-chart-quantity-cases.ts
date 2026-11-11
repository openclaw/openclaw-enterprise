type QuantityInput = readonly [field: string, value: string];
type StderrRefusal = readonly [...QuantityInput, stderr: string];
type RegexRefusal = readonly [...QuantityInput, diagnostic: RegExp];
type SuffixRefusal = readonly [...RegexRefusal, base: "defaults" | "collector"];

export const resourceNameAndSignRefusals: readonly StderrRefusal[] = [
  ["resources.limits.cpu", "-1", "resources.limits.cpu must not be negative"],
  ["resources.requests.cpu", "-.5m", "resources.requests.cpu must not be negative"],
  // The quantity check trims the value, so the sign check does too.
  ["resources.requests.cpu", " -1", "resources.requests.cpu must not be negative"],
  [
    "slackProxy.resources.requests.memory",
    "-64Mi",
    "slackProxy.resources.requests.memory must not be negative",
  ],
  [
    "logging.collector.state.sizeLimit",
    "-1Mi",
    "logging.collector.state.sizeLimit must not be negative",
  ],
  ["logging.collector.tmp.sizeLimit", "-1", "logging.collector.tmp.sizeLimit must not be negative"],
  ["resources.limits.gpu", "1", "resources.limits.gpu names a resource Kubernetes does not accept"],
  [
    "logging.collector.resources.requests.requests\\.example\\.com/gpu",
    "1",
    "requests.example.com/gpu names a resource",
  ],
  [
    "slackProxy.resources.limits.hugepages-huge",
    "4Mi",
    "slackProxy.resources.limits.hugepages-huge names a resource",
  ],
  // The name after the domain prefix holds at most 63 characters.
  [
    `resources.limits.example\\.com/${"g".repeat(64)}`,
    "1",
    `resources.limits.example.com/${"g".repeat(64)} names a resource`,
  ],
];

const memoryRequestQuantityError = /resources\.requests\.memory must be a Kubernetes quantity/;

export const quantityRefusals = {
  "--set": {
    syntax: [
      ["logging.collector.state.sizeLimit", "foo"],
      ["logging.collector.tmp.sizeLimit", "10MiB"],
      ["resources.requests.cpu", "foo"],
      ["logging.collector.resources.limits.memory", "10MiB"],
    ],
    uppercaseSuffix: [
      ["resources.requests.memory", "1K", memoryRequestQuantityError, "defaults"],
      [
        "logging.collector.resources.requests.memory",
        "1K",
        /logging\.collector\.resources\.requests\.memory must be a Kubernetes quantity/,
        "collector",
      ],
      [
        "logging.collector.state.sizeLimit",
        "1K",
        /logging\.collector\.state\.sizeLimit must be a Kubernetes quantity/,
        "collector",
      ],
      ["resources.requests.memory", "1KI", memoryRequestQuantityError, "defaults"],
    ],
  },
  "--set-string": [
    ["resources.requests.cpu", "  foo ", /resources\.requests\.cpu must be a Kubernetes quantity/],
    ["resources.requests.memory", " 1K ", memoryRequestQuantityError],
    ["resources.requests.memory", "\t64Mi", memoryRequestQuantityError],
  ],
} as const satisfies {
  "--set": {
    syntax: readonly QuantityInput[];
    uppercaseSuffix: readonly SuffixRefusal[];
  };
  "--set-string": readonly RegexRefusal[];
};

type CollectorVolumeLimitField =
  "logging.collector.state.sizeLimit" | "logging.collector.tmp.sizeLimit";

type CollectorVolumeLimitCase = Readonly<{
  overrides: Partial<Record<CollectorVolumeLimitField, "null">>;
  expectedState: string | null;
  expectedTmp: string | null;
}>;

export const collectorVolumeLimitCases: readonly CollectorVolumeLimitCase[] = [
  {
    overrides: {
      "logging.collector.state.sizeLimit": "null",
      "logging.collector.tmp.sizeLimit": "null",
    },
    expectedState: null,
    expectedTmp: null,
  },
  {
    overrides: { "logging.collector.state.sizeLimit": "null" },
    expectedState: null,
    expectedTmp: "64Mi",
  },
  {
    overrides: { "logging.collector.tmp.sizeLimit": "null" },
    expectedState: "128Mi",
    expectedTmp: null,
  },
];
