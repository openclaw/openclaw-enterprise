import { match } from "ts-pattern";
import { Type } from "typebox";
import { Check } from "typebox/value";

export type NetworkDestinationRule = Readonly<{
  destination:
    | Readonly<{ kind: "dns"; name: string; match: "exact" | "subdomains" }>
    | Readonly<{ kind: "ip"; address: string }>
    | Readonly<{ kind: "cidr"; cidr: string }>;
  ports: readonly number[];
}>;

export const NetworkDestinationRuleSchema = Type.Object(
  {
    destination: Type.Union([
      Type.Object(
        {
          kind: Type.Literal("dns"),
          name: Type.String({ minLength: 1, maxLength: 253 }),
          match: Type.Union([Type.Literal("exact"), Type.Literal("subdomains")]),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        { kind: Type.Literal("ip"), address: Type.String({ minLength: 1, maxLength: 45 }) },
        { additionalProperties: false },
      ),
      Type.Object(
        { kind: Type.Literal("cidr"), cidr: Type.String({ minLength: 3, maxLength: 49 }) },
        { additionalProperties: false },
      ),
    ]),
    ports: Type.Array(Type.Integer({ minimum: 1, maximum: 65535 }), {
      minItems: 1,
      maxItems: 256,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

function addressBits(address: string): { value: bigint; width: number } {
  if (/^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/.test(address)) {
    const octets = address.split(".").map(Number);
    if (octets.every((octet) => octet <= 255)) {
      return {
        value: octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n),
        width: 32,
      };
    }
  }
  if (/^[0-9a-f:]+$/.test(address) && address.includes(":")) {
    try {
      if (new URL(`http://[${address}]/`).hostname !== `[${address}]`) {
        throw new Error("Noncanonical address.");
      }
      const [left = "", right] = address.split("::");
      const first = left === "" ? [] : left.split(":");
      const last = right === undefined || right === "" ? [] : right.split(":");
      const groups =
        right === undefined
          ? first
          : [...first, ...Array(8 - first.length - last.length).fill("0"), ...last];
      return {
        value: groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n),
        width: 128,
      };
    } catch {
      // The URL parser also rejects IPv6 zone identifiers and malformed compression.
    }
  }
  throw new Error("Network destinations require canonical IPv4 or IPv6 addresses.");
}

/** Validate Driver output before any infrastructure effects. No address is resolved here. */
export function normalizeNetworkDestinationRules(
  input: unknown,
): readonly NetworkDestinationRule[] {
  if (!Array.isArray(input) || input.length > 128) {
    throw new Error("Network destinations must be an array of at most 128 rules.");
  }
  return Object.freeze(
    input.map((raw) => {
      if (!Check(NetworkDestinationRuleSchema, raw)) {
        throw new Error("Invalid network destination rule.");
      }
      const rule = raw as NetworkDestinationRule;
      const destination = match(rule.destination)
        .with({ kind: "dns" }, (destination) => {
          const name = destination.name.toLowerCase();
          if (
            !name
              .split(".")
              .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
            /^[0-9.]+$/.test(name)
          ) {
            throw new Error(
              "DNS destinations require ASCII DNS labels without wildcards, URLs or ports.",
            );
          }
          return { ...destination, name };
        })
        .with({ kind: "ip" }, (destination) => {
          addressBits(destination.address);
          return destination;
        })
        .with({ kind: "cidr" }, (destination) => {
          const parts = destination.cidr.split("/");
          const prefix = parts[1];
          if (parts.length !== 2 || prefix === undefined || !/^(0|[1-9][0-9]*)$/.test(prefix)) {
            throw new Error("Network destinations require canonical CIDRs.");
          }
          const { value, width } = addressBits(parts[0]!);
          const length = Number(prefix);
          if (length > width || (value & ((1n << BigInt(width - length)) - 1n)) !== 0n) {
            throw new Error("Network CIDRs must name a canonical network prefix.");
          }
          return destination;
        })
        .exhaustive();
      return Object.freeze({
        destination: Object.freeze(destination),
        ports: Object.freeze([...rule.ports].sort((a, b) => a - b)),
      });
    }),
  );
}
