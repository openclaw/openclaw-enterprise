//! Portable signed Credential Proxy installation exchange. Never fall back to unary resolve or direct send.
use crate::responses_capture::Capture;
use crate::{
    Config,
    origin::{self, AdmittedRoute},
    selection::Selected,
};
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use egress_gateway::{
    DelegatedFailure, DelegatedReply, DelegatedRequest, HeaderMap, RequestExchange,
};
use http_body_util::Full;
use prost::Message;
use prost_types::Timestamp;
use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
    signature::{Ed25519KeyPair, KeyPair},
};
use std::{
    fs,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{runtime::Handle, sync::mpsc};
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Endpoint};
use uuid::Uuid;
use zeroize::Zeroizing;

// Names and oneof layouts come from the owning protobuf, not the gateway.
#[allow(dead_code, clippy::enum_variant_names, clippy::large_enum_variant)]
mod openshell {
    pub mod extension {
        pub mod v1 {
            tonic::include_proto!("openshell.extension.v1");
        }
    }
    pub mod middleware {
        pub mod v1 {
            tonic::include_proto!("openshell.middleware.v1");
        }
    }
}
pub(crate) use openshell::middleware::v1 as wire;
use wire::{
    http_credential_authorize_send_response::Result as Authorization,
    http_credential_resolve_response::Result as Resolution,
    installation_exchange_reply::Event as Reply, installation_exchange_request::Event,
};

pub struct CredentialProxy {
    pub config: Config,
    pub policy_hash: String,
    pub key: Ed25519KeyPair,
    pub instance: String,
    routes: Vec<AdmittedRoute>,
    runtime: Handle,
    channel: Channel,
}

impl CredentialProxy {
    pub fn new(
        config: Config,
        policy_hash: String,
        key: Ed25519KeyPair,
        routes: Vec<AdmittedRoute>,
        authority_ca: Vec<u8>,
    ) -> Result<Self> {
        ensure!(routes.len() <= 64, "too many installed routes");
        let endpoint = Endpoint::from_shared(config.authority_uri.clone())?;
        ensure!(
            endpoint.uri().scheme_str() == Some("https"),
            "Credential Proxy authority requires TLS"
        );
        let ca = Certificate::from_pem(authority_ca);
        let channel = endpoint
            .tls_config(ClientTlsConfig::new().ca_certificate(ca))?
            .connect_timeout(Duration::from_secs(5))
            .connect_lazy();
        Ok(Self {
            config,
            policy_hash,
            key,
            instance: Uuid::new_v4().to_string(),
            channel,
            runtime: Handle::current(),
            routes,
        })
    }

    /// Check projection matches this process before sending. OCE authenticates actual issuer signature,
    /// expiry, sandbox, sender, peer, policy, acknowledged installation and response association.
    fn bearer(&self) -> Result<tonic::metadata::AsciiMetadataValue> {
        let bearer = Zeroizing::new(fs::read_to_string(&self.config.bearer_path)?);
        let jwt = bearer.trim();
        ensure!(
            jwt.len() < 8000 && jwt.split('.').count() == 3,
            "execution bearer unavailable"
        );
        let payload =
            URL_SAFE_NO_PAD.decode(jwt.split('.').nth(1).context("expected execution JWT")?)?;
        let claims: serde_json::Value = serde_json::from_slice(&payload)?;
        ensure!(
            claims["instance_id"] == self.instance
                && claims["sandbox_id"] == self.config.sandbox_id
                && claims["exchange_key"]["x"]
                    == URL_SAFE_NO_PAD.encode(self.key.public_key().as_ref()),
            "execution bearer projection belongs to a different process"
        );
        let mut meta = format!("Bearer {jwt}").parse::<tonic::metadata::AsciiMetadataValue>()?;
        meta.set_sensitive(true);
        Ok(meta)
    }
}

pub(crate) fn sha256(data: &[u8]) -> String {
    digest::digest(&digest::SHA256, data)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl RequestExchange for CredentialProxy {
    fn exchange(
        &self,
        req: DelegatedRequest<'_>,
    ) -> std::result::Result<DelegatedReply, DelegatedFailure> {
        let mut routes = self
            .routes
            .iter()
            .filter(|r| r.matches(req.target, req.method));
        let route = routes.next().ok_or(DelegatedFailure::Refused)?;
        if routes.next().is_some() || req.body.len() > origin::BODY_LIMIT {
            return Err(DelegatedFailure::Refused);
        }
        // Box and Dogwood allowed the original request. Form one immutable OCE operation *before*
        // opening the signed exchange; an ambiguous privacy projection never reaches authority or origin.
        let captured = Capture::new(req.body, origin::capture(&req), route.inference_responses())
            .map_err(|_| DelegatedFailure::Refused)?;
        let duration =
            Duration::from_millis(route.deadline_ms() - 25.min(route.deadline_ms() / 10));
        let p = Progress::default();
        // On a Box-owned blocking connection thread. Budget includes authority, TLS, origin and protection.
        match self.runtime.block_on(async {
            tokio::time::timeout(duration, self.run(req, route, captured, &p, duration)).await
        }) {
            Ok(Ok(reply)) => Ok(reply),
            outcome => {
                // Log only a fixed stage and disposition, never an error carrying request/material/response data.
                if p.stage.load(SeqCst) == 4 && !p.dispatch.load(SeqCst) {
                    p.event("no_permit");
                }
                p.event("response_blocked");
                if p.dispatch.load(SeqCst) {
                    eprintln!(
                        "strands-credential-proxy: exchange did not release a response; origin dispatch possible; no retry"
                    );
                    Err(DelegatedFailure::Uncertain {
                        accepted_bytes: p.bytes.load(SeqCst),
                    })
                } else if let code @ 1..=5 = p.refusal_code.load(SeqCst) {
                    eprintln!(
                        "strands-credential-proxy: authority refused at stage {} before origin send (refusal_code={code})",
                        p.stage.load(SeqCst)
                    );
                    Err(if code == 1 {
                        DelegatedFailure::Refused
                    } else {
                        DelegatedFailure::Unavailable
                    })
                } else {
                    eprintln!(
                        "strands-credential-proxy: exchange stopped at stage {} before origin send (deadline={})",
                        p.stage.load(SeqCst),
                        outcome.is_err()
                    );
                    Err(DelegatedFailure::Unavailable)
                }
            }
        }
    }
}

#[derive(Default)]
struct Progress {
    // Locally generated, nonsecret replay ID. Never log the handle, proof, custody, origin, policy or payload.
    request_id: OnceLock<String>,
    dispatch: AtomicBool,
    refusal_code: AtomicUsize,
    bytes: Arc<AtomicUsize>,
    stage: AtomicUsize,
}

impl Progress {
    fn event(&self, stage: &str) {
        if let Some(id) = self.request_id.get() {
            eprintln!("strands-credential-proxy: custody request_id={id} stage={stage}");
        }
    }
}

impl CredentialProxy {
    async fn run(
        &self,
        req: DelegatedRequest<'_>,
        route: &AdmittedRoute,
        captured: Capture,
        p: &Progress,
        duration: Duration,
    ) -> Result<DelegatedReply> {
        let audience = &self.config.audience;
        let (context, deadline) = new_operation(&self.config.sandbox_id, duration);
        let _ = p.request_id.set(context.request_id.clone());
        let deadline_at = to_timestamp(deadline)?;
        let mut custody = [0u8; 32];
        SystemRandom::new()
            .fill(&mut custody)
            .map_err(|_| anyhow::anyhow!("response custody entropy unavailable"))?;

        let (tx, rx) = mpsc::channel::<wire::InstallationExchangeRequest>(1);
        let mut opening = tonic::Request::new(ReceiverStream::new(rx));
        opening
            .metadata_mut()
            .insert("authorization", self.bearer()?);
        opening.set_timeout(deadline.duration_since(SystemTime::now())?);
        let mut client =
            wire::http_installation_exchange_client::HttpInstallationExchangeClient::new(
                self.channel.clone(),
            );
        p.stage.store(1, SeqCst);
        let mut stream = client.exchange(opening).await?.into_inner();
        let Some(Reply::Challenge(challenge)) = next(&mut stream).await? else {
            anyhow::bail!("expected signed exchange challenge")
        };
        ensure!(challenge.len() == 32, "invalid challenge");
        let Capture { headers, body } = captured;
        let resolve = wire::HttpCredentialResolveRequest {
            request: Some(wire::HttpRequestEvaluation {
                phase: 1,
                context: Some(context.clone()),
                target: Some(wire::HttpRequestTarget {
                    scheme: "https".into(),
                    host: req.target.host.clone(),
                    port: req.target.port.into(),
                    method: req.method.into(),
                    path: req.target.path.clone(),
                    query: String::new(),
                }),
                headers: headers.clone(),
                body: body.to_vec(),
                middleware_name: "oce-strands-credential-proxy".into(),
                ..Default::default()
            }),
            deadline: Some(deadline_at),
            audience: audience.clone(),
            response_custody: custody.to_vec(),
            verified_execution_policy_hash: self.policy_hash.clone(),
        }
        .encode_to_vec();
        let signed = [b"openshell-exchange-v1\0".as_slice(), &challenge, &resolve].concat();
        let signature = self.key.sign(&signed).as_ref().to_vec();
        send(
            &tx,
            Event::Open(wire::InstallationExchangeOpen {
                resolve_request: resolve,
                signature,
            }),
        )
        .await?;
        p.stage.store(2, SeqCst);
        let Some(Reply::Resolved(resolved)) = next(&mut stream).await? else {
            anyhow::bail!("expected resolution")
        };
        let resolution = resolved.result.context("missing authority selection")?;
        if let Resolution::Refused(r) = resolution {
            p.refusal_code.store(r.code as usize, SeqCst);
            anyhow::bail!("resolution refused")
        }
        let mut builder = hyper::Request::builder()
            .method(req.method)
            .uri(&req.target.path);
        for h in &headers {
            builder = builder.header(&h.name, &h.value)
        }
        let selected = Selected::bind(
            resolution,
            route.profile(),
            builder.headers_mut().context("invalid captured headers")?,
            context,
            audience,
            deadline_at,
        )?;
        let request = builder.body(Full::new(body))?;
        p.event("resolve_accepted");

        // Pin and authenticate the one origin socket BEFORE fresh send authorization. Never use another.
        p.stage.store(3, SeqCst);
        let tls = route.connect(req.origin).await?;
        p.stage.store(4, SeqCst);
        send(&tx, Event::Authorize(selected.authorize.clone())).await?;
        let Some(Reply::Authorized(authorized)) = next(&mut stream).await? else {
            anyhow::bail!("expected final send authorization")
        };
        let permit = match authorized.result.context("missing send authorization")? {
            Authorization::Allowed(a) => a,
            Authorization::Refused(r) => {
                p.refusal_code.store(r.code as usize, SeqCst);
                anyhow::bail!("send refused")
            }
        };
        let start_by = selected.check_permit(&permit, &custody)?;
        p.event("permit_accepted");
        p.dispatch.store(true, SeqCst);
        let response = origin::dispatch(tls, request, p.bytes.clone(), start_by).await?;
        // Complete actual response, including trailers. Same unforgeable custody and duplex; never release locally on error.
        send(&tx, Event::Response(response)).await?;
        let Some(Reply::Response(safe)) = next(&mut stream).await? else {
            anyhow::bail!("response not protected")
        };
        ensure!(
            safe.response_complete
                && safe.trailers.is_empty()
                && (200..=599).contains(&safe.status)
                && safe.body.len() <= origin::BODY_LIMIT
                && SystemTime::now() < deadline,
            "incomplete, unsupported or late protected response"
        );
        let headers = HeaderMap::from_pairs(safe.headers.into_iter().map(|h| (h.name, h.value)));
        p.event("response_released");
        Ok(DelegatedReply {
            status: safe.status as u16,
            headers,
            body: safe.body,
            accepted_bytes: p.bytes.load(SeqCst),
        })
    }
}

async fn next(s: &mut tonic::Streaming<wire::InstallationExchangeReply>) -> Result<Option<Reply>> {
    Ok(s.message().await?.and_then(|r| r.event))
}
async fn send(tx: &mpsc::Sender<wire::InstallationExchangeRequest>, event: Event) -> Result<()> {
    tx.send(wire::InstallationExchangeRequest { event: Some(event) })
        .await
        .context("closed installation exchange")
}
pub(crate) fn timestamp_ms(ts: Timestamp) -> Result<u64> {
    ensure!(
        ts.seconds >= 0 && (0..1_000_000_000).contains(&ts.nanos),
        "invalid authority timestamp"
    );
    Ok(ts.seconds as u64 * 1000 + ts.nanos as u64 / 1_000_000)
}
fn to_timestamp(time: SystemTime) -> Result<Timestamp> {
    let d = time.duration_since(UNIX_EPOCH)?;
    Ok(Timestamp {
        seconds: d.as_secs() as i64,
        nanos: d.subsec_nanos() as i32,
    })
}

/// OCC's replay window is anchored to the UUIDv7 creation time, independently of the deadline.
/// A process instance uses UUIDv4; each operation gets one new UUIDv7 and is never retried.
fn new_operation(sandbox_id: &str, duration: Duration) -> (wire::RequestContext, SystemTime) {
    let id = Uuid::now_v7();
    let (seconds, nanos) = id
        .get_timestamp()
        .expect("UUIDv7 has a timestamp")
        .to_unix();
    let deadline = UNIX_EPOCH + Duration::new(seconds, nanos) + duration;
    (
        wire::RequestContext {
            request_id: id.to_string(),
            sandbox_id: sandbox_id.into(),
            ..Default::default()
        },
        deadline,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_context_and_deadline_share_the_supplier_uuidv7_replay_horizon() {
        let (context, deadline) = new_operation("fixture-sandbox", Duration::from_millis(20_000));
        let id = Uuid::parse_str(&context.request_id).unwrap();
        assert_eq!(id.get_version_num(), 7);
        let bytes = id.as_bytes();
        // Exactly the first 48 bits OCC parses in packages/occ/src/credential-proxy.ts:operationCreatedAt.
        let created_ms = bytes[..6].iter().fold(0u64, |ms, b| (ms << 8) | *b as u64);
        assert_eq!(
            deadline.duration_since(UNIX_EPOCH).unwrap().as_millis(),
            (created_ms + 20_000) as u128
        );

        // Optional portable peer test takes these exact wire fields through the signed supplier RPC.
        // It runs only in this Rust test binary, uses no execution credentials and cannot send to a provider.
        if let Some(path) = std::env::var_os("STRANDS_TEST_OPERATION_WIRE") {
            let request = wire::HttpCredentialResolveRequest {
                request: Some(wire::HttpRequestEvaluation {
                    context: Some(context),
                    ..Default::default()
                }),
                deadline: Some(to_timestamp(deadline).unwrap()),
                ..Default::default()
            };
            std::fs::write(path, request.encode_to_vec()).unwrap();
        }
    }
}
