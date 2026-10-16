//! One trusted Strands Box inspection gateway per admitted execution, outside the workload Pod.
mod exchange;
mod history;
mod installation_profile;
mod origin;
mod responses_capture;
mod selection;

use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bytes::Bytes;
use egress_gateway::{MitmConfig, MitmInterceptor, ResponseLimits};
use exchange::{CredentialProxy, sha256};
use http_body_util::Full;
use hyper::{Request, Response, body::Incoming, service::service_fn};
use hyper_util::rt::TokioIo;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::Deserialize;
use std::{convert::Infallible, fs, net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};
use tokio::net::TcpListener;
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    sandbox_id: String,
    audience: String,
    authority_uri: String,
    authority_ca_path: PathBuf,
    exchange_seed_path: PathBuf,
    bearer_path: PathBuf,
    policy_path: PathBuf,
    state_dir: PathBuf,
    listen: SocketAddr,
    probe_listen: SocketAddr,
}

/// Bindings, route material profiles and authority in this document contribute to the installed policy hash.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledPolicy {
    version: u64,
    sender_image: String,
    plan: serde_json::Value,
    authority: BoundAuthority,
    dogwood_policy: String,
    routes: Vec<origin::Route>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoundAuthority {
    uri: String,
    audience: String,
    ca_sha256: String,
}

#[tokio::main(worker_threads = 2)]
async fn main() -> Result<()> {
    let path = std::env::args_os()
        .nth(1)
        .context("usage: strands-credential-proxy CONFIG.json")?;
    if path == "--installation-profile" {
        return installation_profile::serve().await;
    }
    let config: Config = serde_json::from_slice(&fs::read(path)?)?;
    ensure!(
        !config.sandbox_id.is_empty() && !config.audience.is_empty(),
        "missing execution identity"
    );
    let seed = Zeroizing::new(
        fs::read(&config.exchange_seed_path).context("read execution exchange seed")?,
    );
    let key = Ed25519KeyPair::from_seed_unchecked(&seed)
        .map_err(|_| anyhow::anyhow!("expected raw 32-byte execution key seed"))?;
    drop(seed);
    let policy_bytes = fs::read(&config.policy_path)?;
    let policy_hash = sha256(&policy_bytes);
    let policy: InstalledPolicy = serde_json::from_slice(&policy_bytes)?;
    // The signed policy commits to the sender manifest required by the controller. Only the
    // execution platform can verify this container's actual image against that requirement.
    ensure!(
        policy.version == 2
            && policy
                .sender_image
                .rsplit_once("@sha256:")
                .is_some_and(|(image, digest)| {
                    !image.is_empty()
                        && digest.len() == 64
                        && digest
                            .bytes()
                            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                }),
        "installed policy must bind an immutable sender image"
    );

    // The signed policy observation covers the actual execution and the authority that can authorize
    // its single origin send. Never load alternate endpoints or trust from an unsigned config field.
    let authority_ca = fs::read(&config.authority_ca_path)?;
    ensure!(
        policy
            .plan
            .pointer("/execution/executionId")
            .and_then(|id| id.as_str())
            == Some(&config.sandbox_id)
            && policy.authority.uri == config.authority_uri
            && policy.authority.audience == config.audience
            && policy.authority.ca_sha256 == sha256(&authority_ca),
        "loaded execution or authority differs from installed policy"
    );

    let routes = origin::installed_routes(&policy.plan, policy.routes)?;

    let initial = fs::metadata(&config.bearer_path)
        .context("initial bearer projection")?
        .len()
        == 0;
    let effects = history::load(
        &config.state_dir,
        &config.policy_path,
        policy.dogwood_policy,
        &config.sandbox_id,
        &URL_SAFE_NO_PAD.encode(key.public_key().as_ref()),
        &policy_hash,
        initial,
    )?;

    let mitm_config = MitmConfig {
        bind_addr: config.listen,
        intercept_ca_dir: Some(config.state_dir.join("intercept-ca")),
        max_connections: 32,
        response_limits: ResponseLimits {
            max_body_bytes: origin::BODY_LIMIT,
        },
        upstream_read_deadline: Duration::from_secs(30),
        ..MitmConfig::default()
    };
    let probe_addr = config.probe_listen;
    let sender = Arc::new(CredentialProxy::new(
        config,
        policy_hash,
        key,
        routes,
        authority_ca,
    )?);
    let handle = MitmInterceptor::start_with_request_exchange(mitm_config, effects, sender.clone())
        .context("start Strands Box governed CONNECT gateway")?;
    let ca = fs::read(
        handle
            .intercept_ca_path()
            .context("public inspection CA path")?,
    )?;
    let probe = Arc::new(Probe {
        sender,
        ca_hash: sha256(&ca),
        ca: Bytes::from(ca),
    });
    // A signed observation is available only after policy, durable history and Box listener exist.
    let listener = TcpListener::bind(probe_addr).await?;
    eprintln!(
        "strands-credential-proxy: policy loaded; inspection and installation listeners ready"
    );
    loop {
        let (stream, _) = listener.accept().await?;
        let probe = probe.clone();
        tokio::spawn(async move {
            let service = service_fn(move |req| probe.clone().respond(req));
            let conn = hyper::server::conn::http1::Builder::new()
                .keep_alive(false)
                .serve_connection(TokioIo::new(stream), service);
            let _ = tokio::time::timeout(Duration::from_secs(5), conn).await;
        });
    }
}

struct Probe {
    sender: Arc<CredentialProxy>,
    ca_hash: String,
    ca: Bytes,
}

impl Probe {
    async fn respond(
        self: Arc<Self>,
        req: Request<Incoming>,
    ) -> Result<Response<Full<Bytes>>, Infallible> {
        let (code, content, body) = match (req.method().as_str(), req.uri().path()) {
            ("GET", "/ca.pem") => (200, "application/x-pem-file", self.ca.clone()),
            ("GET", "/installed") => {
                let challenge = req.uri().query().and_then(|q| q.strip_prefix("challenge="));
                if let Some(c) =
                    challenge.filter(|c| c.len() == 64 && c.bytes().all(|b| b.is_ascii_hexdigit()))
                {
                    match self.installed(c) {
                        Some(observation) => (200, "application/json", observation.into()),
                        None => (
                            503,
                            "text/plain",
                            Bytes::from_static(b"bearer projection not readable"),
                        ),
                    }
                } else {
                    (
                        400,
                        "text/plain",
                        Bytes::from_static(b"a 64-hex challenge is required"),
                    )
                }
            }
            _ => (404, "text/plain", Bytes::new()),
        };
        Ok(Response::builder()
            .status(code)
            .header("content-type", content)
            .header("cache-control", "no-store")
            .body(Full::new(body))
            .expect("static response"))
    }

    fn installed(&self, challenge: &str) -> Option<String> {
        let s = &self.sender;
        let sandbox = &s.config.sandbox_id;
        let policy = &s.policy_hash;
        let instance = &s.instance;
        let peer = URL_SAFE_NO_PAD.encode(s.key.public_key().as_ref());
        let ca = &self.ca_hash;
        let token = Zeroizing::new(fs::read(&s.config.bearer_path).ok()?);
        let bearer = sha256(&token);
        let projected = !token.is_empty();
        let signed = serde_json::to_vec(&[
            "oce-strands-box-installation-v1",
            challenge,
            sandbox,
            policy,
            instance,
            &peer,
            ca,
            &bearer,
        ])
        .expect("strings serialize");
        let signature = URL_SAFE_NO_PAD.encode(s.key.sign(&signed));
        Some(serde_json::json!({"bearerProjected":projected, "sandboxId":sandbox, "policyHash":policy, "instanceId":instance, "peerKeyId":peer,
            "interceptCaSha256":ca, "bearerSha256":bearer, "signature":signature}).to_string())
    }
}
