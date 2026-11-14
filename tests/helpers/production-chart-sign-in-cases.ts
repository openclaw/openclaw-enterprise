import type { ChartValues } from "./production-chart-network-fixture.ts";

type TrustedProxyRefusalCase = readonly [
  description: string,
  override: ChartValues,
  diagnostic: RegExp,
];

export const oidcLoginValues: ChartValues = {
  "auth.oidc.enabled": "true",
  "auth.recoveryUserId": "recovery-admin_1",
  "auth.oidc.issuer": "https://tenant.idp.example.test/",
  "auth.oidc.authorizationUrl": "https://tenant.idp.example.test/authorize",
  "auth.oidc.tokenUrl": "https://tenant.idp.example.test/oauth/token",
  "auth.oidc.jwksUrl": "https://tenant.idp.example.test/.well-known/jwks.json",
};

export function trustedProxyRefusalCases(
  trustedProxyValues: ChartValues,
): readonly TrustedProxyRefusalCase[] {
  function cidrRefusal(
    description: string,
    cidr: string,
    diagnostic: RegExp,
  ): TrustedProxyRefusalCase {
    return [description, { ...trustedProxyValues, "api.trustedProxy.cidrs[0]": cidr }, diagnostic];
  }

  const genericProxyValues = {
    "api.trustedProxy.preset": "generic",
    "api.trustedProxy.cidrs[0]": "10.42.0.0/16",
  };

  return [
    [
      "an unknown trusted proxy preset",
      { ...trustedProxyValues, "api.trustedProxy.preset": "haproxy" },
      /ingress-nginx, aws, or generic/,
    ],
    [
      "a trusted proxy preset without CIDRs",
      { "api.trustedProxy.preset": "ingress-nginx" },
      /requires api\.trustedProxy\.cidrs/,
    ],
    [
      "trusted proxy CIDRs without a preset",
      { "api.trustedProxy.cidrs[0]": "10.42.0.0/16" },
      /require api\.trustedProxy\.preset/,
    ],
    [
      "a client-address header without a preset",
      { "api.trustedProxy.clientAddressHeader": "x-real-ip" },
      /require api\.trustedProxy\.preset/,
    ],
    [
      "a generic trusted proxy without a header",
      { ...trustedProxyValues, "api.trustedProxy.preset": "generic" },
      /generic requires api\.trustedProxy\.clientAddressHeader/,
    ],
    cidrRefusal("a trusted proxy for every IPv4 peer", "0.0.0.0/0", /nonzero prefix/),
    cidrRefusal("a trusted proxy for every IPv6 peer", "::/0", /nonzero prefix/),
    cidrRefusal("a trusted proxy hostname", "ingress.example.invalid", /nonzero prefix/),
    cidrRefusal(
      "a trusted proxy with an invalid IPv4 address",
      "10.420.0.0/16",
      /invalid IPv4 address/,
    ),
    cidrRefusal(
      "a trusted proxy with a leading-zero IPv4 address",
      "01.2.3.4/32",
      /invalid IPv4 address/,
    ),
    cidrRefusal("a trusted proxy with a malformed IPv6 address", "a:/64", /invalid IPv6 address/),
    cidrRefusal(
      "a trusted proxy with more than one IPv6 compression",
      ":::/64",
      /invalid IPv6 address/,
    ),
    cidrRefusal(
      "a trusted proxy with too many IPv6 groups",
      "1:2:3:4:5:6:7:8:9/64",
      /invalid IPv6 address/,
    ),
    cidrRefusal(
      "a trusted proxy with a dotted tail before compression",
      "1.2.3.4::/96",
      /invalid IPv6 address/,
    ),
    cidrRefusal(
      "an IPv4-mapped trusted proxy with an IPv6 prefix",
      "::ffff:192.0.2.1/128",
      /prefix must be 1 through 32/,
    ),
    [
      "the internal client-address header",
      { ...trustedProxyValues, "api.trustedProxy.clientAddressHeader": "X-OCC-Client-IP" },
      /cannot be x-occ-client-ip/,
    ],
    [
      "the cookie header as a client address",
      { ...trustedProxyValues, "api.trustedProxy.clientAddressHeader": "cookie" },
      /cannot be cookie/,
    ],
    [
      "a structured Forwarded header as a client address",
      { ...trustedProxyValues, "api.trustedProxy.clientAddressHeader": "Forwarded" },
      /cannot be forwarded/,
    ],
    [
      "a client-address header list",
      {
        ...trustedProxyValues,
        "api.trustedProxy.clientAddressHeader": "x-real-ip x-forwarded-for",
      },
      /single HTTP header name/,
    ],
    [
      "a client-address header longer than the controller accepts",
      { ...genericProxyValues, "api.trustedProxy.clientAddressHeader": `x-${"a".repeat(63)}` },
      /single HTTP header name of at most 64 characters/,
    ],
    [
      "an API key header as a client address",
      { ...genericProxyValues, "api.trustedProxy.clientAddressHeader": "X-API-Key" },
      /cannot be x-api-key/,
    ],
    [
      "a named preset with another client-address header",
      { ...trustedProxyValues, "api.trustedProxy.clientAddressHeader": "X-Real-IP" },
      /ingress-nginx reads x-forwarded-for; use the generic preset for x-real-ip/,
    ],
  ];
}
