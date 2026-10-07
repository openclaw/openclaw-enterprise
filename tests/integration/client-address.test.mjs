import assert from "node:assert/strict";
import test from "node:test";
import {
  clientAddressConfiguration,
  resolveClientAddress,
} from "../../apps/controller/src/auth/client-address.ts";

test("trusted proxy settings are off unless configured and refuse misconfiguration", () => {
  assert.equal(clientAddressConfiguration({}), undefined);
  const refused = [
    [{ OCC_AUTH_TRUSTED_PROXY_PRESET: "aws" }, /require OCC_AUTH_TRUSTED_PROXY_CIDRS/],
    [{ OCC_AUTH_CLIENT_IP_HEADER: "x-real-ip" }, /require OCC_AUTH_TRUSTED_PROXY_CIDRS/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: " " }, /require OCC_AUTH_TRUSTED_PROXY_CIDRS/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/8," }, /comma-separated list/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/33" }, /invalid CIDR: 10\.0\.0\.0\/33/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/8/1" }, /invalid CIDR/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0/8" }, /invalid CIDR/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: "ingress.example.test" }, /invalid CIDR/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/x" }, /invalid CIDR/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: "0.0.0.0/0" }, /must not trust every address/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/8,::/0" }, /must not trust every address/],
    [
      { OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/8", OCC_AUTH_TRUSTED_PROXY_PRESET: "nginx" },
      /must be one of ingress-nginx, aws, generic/,
    ],
    [
      { OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/8", OCC_AUTH_TRUSTED_PROXY_PRESET: "generic" },
      /generic trusted proxy preset requires OCC_AUTH_CLIENT_IP_HEADER/,
    ],
    [
      { OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/8", OCC_AUTH_CLIENT_IP_HEADER: "x-real-ip" },
      /ingress-nginx trusted proxy preset reads x-forwarded-for/,
    ],
  ];
  for (const header of [
    "X-Forwarded-For",
    "x forwarded",
    "x-occ-client-ip",
    "cookie",
    "forwarded",
  ]) {
    refused.push([
      {
        OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
        OCC_AUTH_TRUSTED_PROXY_PRESET: "generic",
        OCC_AUTH_CLIENT_IP_HEADER: header,
      },
      /OCC_AUTH_CLIENT_IP_HEADER must/,
    ]);
  }
  for (const [environment, message] of refused) {
    assert.throws(
      () => clientAddressConfiguration(environment),
      message,
      JSON.stringify(environment),
    );
  }
});

test("presets fix the client-address header; generic names its own", () => {
  const nginx = clientAddressConfiguration({ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.42.0.0/16" });
  assert.equal(nginx.preset, "ingress-nginx");
  assert.equal(nginx.header, "x-forwarded-for");
  const aws = clientAddressConfiguration({
    OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/16, 2600:1f18::/40",
    OCC_AUTH_TRUSTED_PROXY_PRESET: "aws",
    OCC_AUTH_CLIENT_IP_HEADER: "x-forwarded-for",
  });
  assert.deepEqual(
    [aws.preset, aws.header, aws.cidrs],
    ["aws", "x-forwarded-for", ["10.0.0.0/16", "2600:1f18::/40"]],
  );
  assert.equal(aws.trusts("10.0.200.1"), true);
  assert.equal(aws.trusts("::ffff:10.0.200.1"), true);
  assert.equal(aws.trusts("2600:1f18::1"), true);
  assert.equal(aws.trusts("10.1.0.1"), false);
  assert.equal(aws.trusts("not-an-address"), false);
  const generic = clientAddressConfiguration({
    OCC_AUTH_TRUSTED_PROXY_CIDRS: "192.0.2.10",
    OCC_AUTH_TRUSTED_PROXY_PRESET: "generic",
    OCC_AUTH_CLIENT_IP_HEADER: "x-real-ip",
  });
  assert.equal(generic.header, "x-real-ip");
  assert.equal(generic.trusts("192.0.2.10"), true);
  assert.equal(generic.trusts("192.0.2.11"), false);
});

test("trusted proxy CIDRs refuse catch-all IPv6 subnets and mapped addresses with IPv6 prefixes", () => {
  // Node also checks IPv4 peers against IPv6 subnets enclosing the mapped /96.
  for (const cidr of ["::/1", "::/8", "::/80", "::1/80", "::8000:1234:5678/81", "::fffe:0:0/95"]) {
    assert.throws(
      () => clientAddressConfiguration({ OCC_AUTH_TRUSTED_PROXY_CIDRS: cidr }),
      /must not trust every address/,
      cidr,
    );
  }
  for (const cidr of [
    "::ffff:0:0/96",
    "::FFFF:c000:201/33",
    "0:0:0:0:0:ffff:192.0.2.1/128",
    "0::ffff:1.2.3.4/96",
    "::0:ffff:1.2.3.4/33",
  ]) {
    assert.throws(
      () => clientAddressConfiguration({ OCC_AUTH_TRUSTED_PROXY_CIDRS: cidr }),
      /IPv4-mapped address, whose prefix must be 1 through 32/,
      cidr,
    );
  }
});

test("all mapped trusted proxy spellings use IPv4 subnet widths", () => {
  for (const [cidr, host] of [
    ["::ffff:192.0.2.1/32", "192.0.2.1"],
    ["::FFFF:c000:201/32", "192.0.2.1"],
    ["0:0:0:0:0:ffff:192.0.2.1/32", "192.0.2.1"],
    ["0::ffff:1.2.3.4/32", "1.2.3.4"],
    ["::0:ffff:1.2.3.4/32", "1.2.3.4"],
    ["0000:0000:0000:0000:0000:FFFF:C000:0201/1", "192.0.2.1"],
    ["::ffff:c000:201", "192.0.2.1"],
  ]) {
    const config = clientAddressConfiguration({ OCC_AUTH_TRUSTED_PROXY_CIDRS: cidr });
    // A mapped host at /32 must never grant header authority to unrelated IPv4 peers.
    assert.equal(config.trusts(host), true, cidr);
    assert.equal(config.trusts(`::ffff:${host}`), true, cidr);
    assert.equal(config.trusts("8.8.8.8"), false, cidr);
    assert.equal(config.trusts("::ffff:808:808"), false, cidr);
  }
});

test("IPv6 trusted proxies outside the mapped catch-all keep their subnet semantics", () => {
  for (const [cidr, host] of [
    ["::1/128", "::1"],
    ["fd00:10::/64", "fd00:10::1234"],
    ["2600:1f18::/40", "2600:1f18::1"],
    ["fe80::/10", "fe80::1"],
    ["::/81", "::1"],
    ["::/96", "::192.0.2.1"],
    ["::fffe:0:0/96", "::fffe:c000:201"],
    ["64:ff9b::/96", "64:ff9b::192.0.2.1"],
    // Only ::ffff:0:0/96 is IPv4-mapped: a nonzero fifth group keeps an IPv6 host.
    ["::1:ffff:c000:201/128", "::1:ffff:c000:201"],
  ]) {
    const config = clientAddressConfiguration({ OCC_AUTH_TRUSTED_PROXY_CIDRS: cidr });
    assert.equal(config.trusts(host), true, cidr);
    assert.equal(config.trusts("8.8.8.8"), false, cidr);
    assert.equal(config.trusts("192.0.2.1"), false, cidr);
  }
});

test("the client address comes only from a trusted peer, walking right to left", () => {
  const config = clientAddressConfiguration({ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/24" });
  const cases = [
    // Unconfigured or untrusted peers never read the header.
    [undefined, "10.0.0.9", "1.2.3.4", "10.0.0.9"],
    [config, "192.0.2.7", "1.2.3.4", "192.0.2.7"],
    [config, "::ffff:192.0.2.7", "1.2.3.4", "192.0.2.7"],
    // All mapped peer and hop spellings share the same dotted IPv4 rate-limit key.
    [undefined, "::FFFF:c000:207", "1.2.3.4", "192.0.2.7"],
    [config, "0:0:0:0:0:ffff:192.0.2.7", "1.2.3.4", "192.0.2.7"],
    [config, "0::ffff:10.0.0.9", "::FFFF:c000:207, ::0:ffff:10.0.0.8", "192.0.2.7"],
    [config, "::ffff:a00:9", "1.2.3.4, unknown", "10.0.0.9"],
    // A client-supplied prefix is skipped: the proxy appended the address it saw.
    [config, "10.0.0.9", "6.6.6.6, 1.2.3.4", "1.2.3.4"],
    [config, "::ffff:10.0.0.9", "1.2.3.4, 10.0.0.8, 10.0.0.9", "1.2.3.4"],
    [config, "10.0.0.9", ["6.6.6.6", "2001:db8::1"], "2001:db8::1"],
    // Missing, malformed or all-trusted values fall back to the peer.
    [config, "10.0.0.9", undefined, "10.0.0.9"],
    [config, "10.0.0.9", "", "10.0.0.9"],
    [config, "10.0.0.9", "1.2.3.4, unknown", "10.0.0.9"],
    [config, "10.0.0.9", "1.2.3.4:5678", "10.0.0.9"],
    [config, "10.0.0.9", "10.0.0.1, 10.0.0.2", "10.0.0.9"],
  ];
  for (const [configuration, peer, header, expected] of cases) {
    assert.equal(
      resolveClientAddress(configuration, peer, header),
      expected,
      JSON.stringify({ peer, header }),
    );
  }
});
