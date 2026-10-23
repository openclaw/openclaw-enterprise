import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { egressAssociationInstallation } from "@openclaw-enterprise/contracts";
import type { EgressRef } from "@openclaw-enterprise/contracts";
import type {
  AcceptedEgressAssociation,
  CapturedEgressUse,
  EgressPeer,
  EgressExchangeOwner,
} from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";

export interface OpenShellEgressIdentityOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
  readonly publicKey: string | Buffer;
  readonly sender: EgressRef;
}

/** Verifies gateway-signed extension JWTs; callers must enforce the required identity kind. */
export class OpenShellExtensionJwtVerifier {
  private readonly key: KeyObject;
  private readonly options: Pick<
    OpenShellEgressIdentityOptions,
    "issuer" | "audience" | "keyId" | "publicKey"
  >;

  constructor(
    options: Pick<OpenShellEgressIdentityOptions, "issuer" | "audience" | "keyId" | "publicKey">,
  ) {
    this.options = options;
    this.key = createPublicKey(options.publicKey);
    if (
      this.key.asymmetricKeyType !== "ed25519" ||
      !options.issuer ||
      !options.audience ||
      !options.keyId
    ) {
      throw new Error("Invalid OpenShell extension identity configuration.");
    }
  }

  verify(authorization: string): Record<string, unknown> | undefined {
    if (!authorization.startsWith("Bearer ") || authorization.length > 8192) {
      return undefined;
    }
    const token = authorization.slice(7);
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
      return undefined;
    }
    try {
      const header = asRecord(JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")));
      if (
        !header ||
        header.alg !== "EdDSA" ||
        header.typ !== "openshell-ext+jwt" ||
        header.kid !== this.options.keyId ||
        header.crit !== undefined ||
        !verify(
          null,
          Buffer.from(`${parts[0]}.${parts[1]}`),
          this.key,
          Buffer.from(parts[2]!, "base64url"),
        )
      ) {
        return undefined;
      }
      const claims = asRecord(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
      const now = Math.floor(Date.now() / 1000);
      if (
        !claims ||
        claims.iss !== this.options.issuer ||
        claims.aud !== this.options.audience ||
        typeof claims.iat !== "number" ||
        !Number.isSafeInteger(claims.iat) ||
        typeof claims.exp !== "number" ||
        !Number.isSafeInteger(claims.exp) ||
        claims.iat > now + 5 ||
        claims.exp <= now ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > 3600 ||
        typeof claims.jti !== "string" ||
        claims.jti.length === 0
      ) {
        return undefined;
      }
      return claims;
    } catch {
      return undefined;
    }
  }
}

function instanceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

interface AcceptedExchange {
  readonly bearer: string;
  readonly peer: EgressPeer;
  readonly requestId: string;
  readonly responseCustody: Buffer;
  readonly custodyId: string;
  use?: CapturedEgressUse;
  association?: AcceptedEgressAssociation;
}

const commitment = (input: Buffer | string) => createHash("sha256").update(input).digest("hex");

/** The enrolled supervisor pins the downstream; this owner pins its signed opening and duplex. */
export class OpenShellEgressIdentity implements EgressExchangeOwner {
  readonly audience: string;
  private readonly options: OpenShellEgressIdentityOptions;
  private readonly verifier: OpenShellExtensionJwtVerifier;
  private readonly exchanges = new Map<string, AcceptedExchange>();
  private readonly liveCustodies = new Set<string>();

  /** Only the accepted duplex stream holds this local capability; never put it on the wire. */
  acceptExchange(
    bearer: string,
    challenge: Buffer,
    request: Buffer,
    signature: Buffer,
    // Decode these fields from the exact signed bytes, after checking possession.
    opening: () => { requestId: string; sandboxId: string; responseCustody: Buffer },
    signal: AbortSignal,
  ): string | undefined {
    const claims = this.claims(bearer);
    const peer = this.peer(claims);
    const binding = asRecord(claims?.exchange_key);
    if (
      !peer ||
      challenge.length !== 32 ||
      signature.length !== 64 ||
      binding?.profile !== "openshell-exchange-v1" ||
      binding?.kty !== "OKP" ||
      binding?.crv !== "Ed25519" ||
      typeof binding?.x !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(binding.x) ||
      this.exchanges.size >= 1024
    ) {
      return undefined;
    }
    try {
      const key = createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: binding.x },
        format: "jwk",
      });
      if (
        !verify(
          null,
          Buffer.concat([Buffer.from("openshell-exchange-v1\0"), challenge, request]),
          key,
          signature,
        )
      ) {
        return undefined;
      }
      const { requestId, sandboxId, responseCustody } = opening();
      const custodyId = commitment(responseCustody);
      if (
        !requestId ||
        sandboxId !== peer.sandboxId ||
        responseCustody.length !== 32 ||
        this.liveCustodies.has(custodyId) ||
        signal.aborted
      ) {
        return undefined;
      }
      // Possession, signed downstream custody and this actual stream are distinct
      // checks. Only commitments and public identifiers are persisted or compared.
      const capability = randomBytes(32).toString("base64url");
      const exchangeId = commitment(capability);
      const exchange = {
        bearer,
        requestId,
        responseCustody,
        custodyId,
        peer: Object.freeze({ ...peer, peerKeyId: binding.x, exchangeId }),
      };
      this.liveCustodies.add(custodyId);
      this.exchanges.set(exchangeId, exchange);
      signal.addEventListener(
        "abort",
        () => {
          this.exchanges.delete(exchangeId);
          this.liveCustodies.delete(custodyId);
          responseCustody.fill(0);
        },
        { once: true },
      );
      return capability;
    } catch {
      return undefined;
    }
  }

  capture(use: CapturedEgressUse): AcceptedEgressAssociation | undefined {
    const exchange = this.exchanges.get(use.peer.exchangeId ?? "");
    if (
      !exchange ||
      exchange.use ||
      exchange.requestId !== use.id ||
      !isDeepStrictEqual(exchange.peer, use.peer)
    ) {
      return undefined;
    }
    exchange.use = use;
    exchange.association = {
      execution: use.installation.plan.execution,
      installation: egressAssociationInstallation(use.installation),
      exchangeId: exchange.peer.exchangeId!,
      responseId: randomBytes(32).toString("hex"),
      custodyId: exchange.custodyId,
    };
    return exchange.association;
  }

  owns(association: AcceptedEgressAssociation, use: CapturedEgressUse): boolean {
    const exchange = this.exchanges.get(association.exchangeId);
    return (
      exchange?.use === use &&
      Date.parse(exchange.peer.expiresAt) > Date.now() &&
      isDeepStrictEqual(exchange.association, association)
    );
  }

  /** Release the signed echo only to the stream whose exact association was acknowledged. */
  responseCustody(
    authorization: string,
    association: AcceptedEgressAssociation,
  ): Buffer | undefined {
    const exchange = this.exchanges.get(commitment(authorization));
    return exchange?.use && this.owns(association, exchange.use)
      ? Buffer.from(exchange.responseCustody)
      : undefined;
  }

  constructor(options: OpenShellEgressIdentityOptions) {
    this.options = options;
    this.audience = options.audience;
    this.verifier = new OpenShellExtensionJwtVerifier(options);
    if (!options.sender.id || options.sender.generation < 1) {
      throw new Error("Invalid OpenShell egress identity configuration.");
    }
  }

  private claims(authorization: string): Record<string, unknown> | undefined {
    return this.verifier.verify(authorization);
  }

  async verify(authorization: string): Promise<EgressPeer | undefined> {
    const exchange = this.exchanges.get(commitment(authorization));
    return exchange && this.peer(this.claims(exchange.bearer)) ? exchange.peer : undefined;
  }

  private peer(claims: Record<string, unknown> | undefined): EgressPeer | undefined {
    if (
      !claims ||
      claims.caller_kind !== "supervisor" ||
      typeof claims.sandbox_id !== "string" ||
      !claims.sandbox_id ||
      !instanceId(claims.instance_id) ||
      claims.sub !== `spiffe://openshell/sandbox/${claims.sandbox_id}`
    ) {
      return undefined;
    }
    return {
      sender: this.options.sender,
      sandboxId: claims.sandbox_id,
      instanceId: claims.instance_id,
      expiresAt: new Date(Number(claims.exp) * 1000).toISOString(),
    };
  }

  /** Preliminary identity only; it cannot establish an exchange or resolve material. */
  supervisor(authorization: string): EgressPeer | undefined {
    return this.peer(this.claims(authorization));
  }

  verifyControl(authorization: string): boolean {
    const claims = this.claims(authorization);
    return (
      claims !== undefined &&
      ((claims.caller_kind === "gateway" &&
        claims.sub === this.options.issuer &&
        claims.sandbox_id === undefined) ||
        (claims.caller_kind === "supervisor" &&
          instanceId(claims.instance_id) &&
          typeof claims.sandbox_id === "string" &&
          claims.sub === `spiffe://openshell/sandbox/${claims.sandbox_id}`))
    );
  }
}
