//! Live source-adoption capability negotiation, served by this same immutable sender binary in the
//! operator's trusted platform namespace. No execution keys, storage, API token or provider inputs.
use anyhow::{Result, ensure};
use bytes::Bytes;
use http_body_util::Full;
use hyper::{Request, Response, body::Incoming, service::service_fn};
use hyper_util::rt::TokioIo;
use serde_json::json;
use std::{convert::Infallible, time::Duration};
use tokio::net::TcpListener;

const PROFILE: &str = "strands-credential-proxy-v1";
const CAPABILITIES: [&str; 6] = [
    "execution-policy-and-sender-proof-v1",
    "signed-credential-proxy-exchange-v1",
    "final-send-and-response-custody-v1",
    "explicit-no-material-v1",
    "warm-repository-metadata-v1",
    "dogwood-private-attempt-history-v1",
];

pub async fn serve() -> Result<()> {
    let uid = std::env::var("OCE_INSTALLATION_POD_UID")?;
    ensure!(!uid.is_empty(), "installation Pod UID required");
    let listener = TcpListener::bind("0.0.0.0:8081").await?;
    loop {
        let (stream, _) = listener.accept().await?;
        let uid = uid.clone();
        tokio::spawn(async move {
            let service = service_fn(move |req: Request<Incoming>| {
                // Require a profile understood by this sender; never mirror caller-supplied capabilities.
                let challenge = req
                    .uri()
                    .query()
                    .and_then(|q| q.strip_prefix("challenge="))
                    .filter(|c| c.len() == 64 && c.bytes().all(|b| b.is_ascii_hexdigit()));
                let (status, body) = match (req.method().as_str(), req.uri().path().strip_prefix("/profile/"), challenge) {
                    ("GET", Some(PROFILE), Some(challenge)) => (200, json!({
                        "podUid": uid, "challenge": challenge, "protocolMajor": 1, "profile": PROFILE,
                        "required": CAPABILITIES, "supported": CAPABILITIES,
                    }).to_string()),
                    _ => (400, "unsupported installation profile or challenge".into()),
                };
                let response = Response::builder()
                    .status(status)
                    .header("cache-control", "no-store")
                    .body(Full::new(Bytes::from(body)))
                    .expect("static response");
                async { Ok::<_, Infallible>(response) }
            });
            let conn = hyper::server::conn::http1::Builder::new()
                .keep_alive(false)
                .serve_connection(TokioIo::new(stream), service);
            let _ = tokio::time::timeout(Duration::from_secs(5), conn).await;
        });
    }
}
