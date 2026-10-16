//! One pinned, verified TLS origin connection. No redirects, retries, decompression or early release.
use crate::exchange::wire::{HttpHeader, InstallationExchangeResponse as Response};
use crate::selection::Profile;
use anyhow::{Context, Result, ensure};
use bytes::Bytes;
use egress_gateway::{DelegatedRequest, ExchangeOrigin, Target};
use http_body_util::{BodyExt, Full};
use hyper::client::conn::http1;
use hyper_util::rt::TokioIo;
use rustls::{ClientConfig, RootCertStore, pki_types::ServerName};
use serde::Deserialize;
use std::{
    io,
    net::IpAddr,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context as Cx, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpStream,
    time::Instant,
};
use tokio_rustls::{TlsConnector, client::TlsStream};

pub const BODY_LIMIT: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub host: String,
    pub port: u16,
    pub method: String,
    pub path: String,
    pub deadline_ms: u64,
    pub origin_ca_pem: Option<String>,
    pub connect_ip: IpAddr,
}

pub struct AdmittedRoute {
    spec: Route,
    profile: Profile,
    tls: Arc<ClientConfig>,
}

impl Route {
    pub fn admit(self, profile: Profile) -> Result<AdmittedRoute> {
        ensure!(
            self.host
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-".contains(&b))
                && !self.host.is_empty()
                && self.port != 0
                && !self.connect_ip.is_unspecified()
                && !self.connect_ip.is_multicast(),
            "invalid origin authority"
        );
        ServerName::try_from(self.host.clone())?;
        ensure!(
            matches!(self.method.as_str(), "POST" | "GET")
                && (1..=30_000).contains(&self.deadline_ms)
                && self.path.starts_with('/')
                && !self.path.contains(['?', '#', '\\']),
            "invalid exact HTTPS operation"
        );
        let mut roots = RootCertStore::empty();
        if let Some(pem) = &self.origin_ca_pem {
            for cert in rustls_pemfile::certs(&mut pem.as_bytes()) {
                roots.add(cert?)?;
            }
            ensure!(!roots.is_empty(), "empty admitted origin CA");
        } else {
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        }
        let tls = ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        Ok(AdmittedRoute {
            spec: self,
            profile,
            tls: Arc::new(tls),
        })
    }
}

/// Read the material profile only from the installed Credential Proxy plan. The corresponding transport
/// route supplies TLS trust and the exact pinned IP, not an option to change the authority's grant.
pub fn installed_routes(
    plan: &serde_json::Value,
    routes: Vec<Route>,
) -> Result<Vec<AdmittedRoute>> {
    let bindings = plan["routes"]
        .as_array()
        .context("missing installed Credential Proxy routes")?;
    ensure!(
        routes.len() == bindings.len(),
        "transport routes differ from Credential Proxy plan"
    );
    routes
        .into_iter()
        .zip(bindings)
        .map(|(r, binding)| {
            let origin = if r.port == 443 {
                format!("https://{}", r.host)
            } else {
                format!("https://{}:{}", r.host, r.port)
            };
            ensure!(
                binding["origin"] == origin
                    && binding["method"] == r.method
                    && binding["path"] == r.path
                    && binding["deadlineMs"].as_u64() == Some(r.deadline_ms),
                "transport operation differs from Credential Proxy plan"
            );
            let grant = binding
                .pointer("/binding/grant/kind")
                .and_then(|p| p.as_str());
            let profile = match (r.method.as_str(), grant) {
                ("POST", Some("inference")) | ("GET", Some("github_repository_metadata")) => {
                    Profile::Credential
                }
                ("GET", Some("credential_free_repository_metadata")) => Profile::NoMaterial,
                _ => anyhow::bail!("unsupported installed grant or method"),
            };
            r.admit(profile)
        })
        .collect()
}

impl AdmittedRoute {
    /// installed_routes accepts POST only for the signed inference grant. The caller has already
    /// matched this exact admitted host, port, path and method, after the Box + Dogwood HTTP decision.
    pub fn inference_responses(&self) -> bool {
        self.spec.method == "POST"
            && self.spec.path.ends_with("/responses")
            && self.profile == Profile::Credential
    }
    pub fn profile(&self) -> Profile {
        self.profile
    }
    pub fn matches(&self, target: &Target, method: &str) -> bool {
        let s = &self.spec;
        target.host == s.host
            && target.port == s.port
            && target.path == s.path
            && method == s.method
            && target.query.is_empty()
    }
    pub fn deadline_ms(&self) -> u64 {
        self.spec.deadline_ms
    }

    pub async fn connect(&self, origin: ExchangeOrigin<'_>) -> Result<TlsStream<TcpStream>> {
        let s = &self.spec;
        let stream = origin.connect(s.connect_ip).await?;
        let tls = TlsConnector::from(self.tls.clone())
            .connect(ServerName::try_from(s.host.clone())?, stream)
            .await?;
        Ok(tls)
    }
}

/// Remove client credentials entirely. Rebuild authority and framing from the bound Box target.
/// These exact remaining headers and body are both signed for OCE classification and sent to origin.
pub fn capture(req: &DelegatedRequest<'_>) -> Vec<HttpHeader> {
    let target = req.target;
    let authority = if target.port == 443 {
        target.host.clone()
    } else {
        format!("{}:{}", target.host, target.port)
    };
    let mut headers = vec![HttpHeader {
        name: "host".into(),
        value: authority,
    }];
    for (name, value) in req.headers.iter() {
        let name = name.to_ascii_lowercase();
        if !matches!(
            name.as_str(),
            "host"
                | "content-length"
                | "authorization"
                | "proxy-authorization"
                | "api-key"
                | "x-api-key"
                | "cookie"
        ) {
            headers.push(HttpHeader {
                name,
                value: value.to_owned(),
            });
        }
    }
    headers
}

pub async fn dispatch(
    tls: TlsStream<TcpStream>,
    request: hyper::Request<Full<Bytes>>,
    counted: Arc<AtomicUsize>,
    start_by: Instant,
) -> Result<Response> {
    let io = Gate {
        tls,
        counted,
        start_by,
    };
    let (mut sender, conn) = http1::Builder::new()
        .max_headers(128)
        .max_buf_size(65536)
        .handshake(TokioIo::new(io))
        .await?;
    let task = tokio::spawn(conn);
    let _guard = Abort(task.abort_handle());
    let response = sender.send_request(request).await?;
    let (parts, mut incoming) = response.into_parts();
    let mut result = Response {
        status: parts.status.as_u16().into(),
        headers: fields(&parts.headers)?,
        ..Default::default()
    };
    // Capture all data AND actual final trailers. No byte of this response can reach the client yet.
    while let Some(frame) = incoming.frame().await.transpose()? {
        match frame.into_data() {
            Ok(data) => {
                ensure!(
                    data.len() <= BODY_LIMIT.saturating_sub(result.body.len()),
                    "origin body limit"
                );
                result.body.extend_from_slice(&data);
            }
            Err(frame) => result.trailers.extend(fields(
                frame.trailers_ref().context("unexpected origin frame")?,
            )?),
        }
    }
    result.response_complete = true;
    Ok(result)
}

fn fields(input: &hyper::HeaderMap) -> Result<Vec<HttpHeader>> {
    ensure!(input.len() <= 128, "too many origin fields");
    input
        .iter()
        .map(|(name, value)| {
            Ok(HttpHeader {
                name: name.as_str().into(),
                value: std::str::from_utf8(value.as_bytes())
                    .context("invalid origin field bytes")?
                    .into(),
            })
        })
        .collect()
}

struct Abort(tokio::task::AbortHandle);
impl Drop for Abort {
    fn drop(&mut self) {
        self.0.abort()
    }
}

/// Enforce the final authorization's actual first-write deadline and report accepted plaintext bytes.
struct Gate {
    tls: TlsStream<TcpStream>,
    counted: Arc<AtomicUsize>,
    start_by: Instant,
}
impl AsyncWrite for Gate {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Cx<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.counted.load(Ordering::Relaxed) == 0 && Instant::now() >= self.start_by {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "origin send-start authorization expired",
            )));
        }
        let n = std::task::ready!(Pin::new(&mut self.tls).poll_write(cx, buf))?;
        self.counted.fetch_add(n, Ordering::Relaxed);
        Poll::Ready(Ok(n))
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Cx<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.tls).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Cx<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.tls).poll_shutdown(cx)
    }
}
impl AsyncRead for Gate {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Cx<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.tls).poll_read(cx, buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use rustls::pki_types::PrivatePkcs8KeyDer;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_rustls::TlsAcceptor;

    /// Policy admission requires a concrete origin pin; an omitted pin or a DNS name must never
    /// become a lookup, a broad network permission, or a credential sent to an alternate origin.
    #[test]
    fn installed_route_without_an_ip_literal_is_not_admissible() {
        let mut route = serde_json::json!({
            "host":"origin.example", "port":443, "method":"POST", "path":"/v1/responses", "deadlineMs":5000
        });
        assert!(serde_json::from_value::<Route>(route.clone()).is_err());
        route["connectIp"] = "alternate.example".into();
        assert!(serde_json::from_value::<Route>(route.clone()).is_err());
        route["connectIp"] = "192.0.2.42".into();
        let admitted = serde_json::from_value::<Route>(route)
            .unwrap()
            .admit(Profile::Credential)
            .unwrap();
        assert_eq!(
            admitted.spec.host, "origin.example",
            "verify the TLS host, never replace it with the pin"
        );
    }

    #[test]
    fn material_profile_is_bound_to_the_exact_installed_plan_route() {
        let transport = serde_json::json!({
            "host":"origin.test", "port":443, "connectIp":"192.0.2.23", "path":"/repos/team/identity", "method":"GET", "deadlineMs":5000
        });
        let bind = |plan: &serde_json::Value, route: &serde_json::Value| {
            installed_routes(plan, vec![serde_json::from_value(route.clone()).unwrap()])
        };
        let mut plan = serde_json::json!({"routes":[{
            "origin":"https://origin.test", "path":"/repos/team/identity", "method":"GET", "deadlineMs":5000,
            "binding":{"grant":{"kind":"credential_free_repository_metadata"}}
        }]});
        assert_eq!(
            bind(&plan, &transport).unwrap()[0].profile(),
            Profile::NoMaterial
        );
        plan["routes"][0]["binding"]["grant"]["kind"] = "github_repository_metadata".into();
        assert_eq!(
            bind(&plan, &transport).unwrap()[0].profile(),
            Profile::Credential
        );
        plan["routes"][0]["method"] = "POST".into();
        assert!(
            bind(&plan, &transport).is_err(),
            "cannot move the selected material profile to another operation"
        );
    }

    /// A late unannounced, repeated trailer survives the real TLS + HTTP parser. OCE receives
    /// these actual values with the complete body; never synthesize "no trailers" from a head.
    #[tokio::test]
    async fn complete_tls_response_includes_even_unannounced_duplicate_final_trailers() {
        let server_name = "origin.test";
        let ck = rcgen::generate_simple_self_signed(vec![server_name.into()]).unwrap();
        let cert = ck.cert.der().clone();
        let key = PrivatePkcs8KeyDer::from(ck.signing_key.serialize_der());
        let server_config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert.clone()], key.into())
            .unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let origin = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut tls = TlsAcceptor::from(Arc::new(server_config))
                .accept(tcp)
                .await
                .unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                head.push(tls.read_u8().await.unwrap())
            }
            assert!(head.starts_with(b"GET /capture HTTP/1.1\r\n"));
            tls.write_all(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n\
                            6\r\nhello!\r\n0\r\nx-late-field: first\r\nx-late-field: second\r\n\r\n")
                .await.unwrap();
            tls.flush().await.unwrap();
        });
        let mut roots = RootCertStore::empty();
        roots.add(cert).unwrap();
        let config = ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let tcp = TcpStream::connect(addr).await.unwrap();
        let tls = TlsConnector::from(Arc::new(config))
            .connect(ServerName::try_from(server_name).unwrap(), tcp)
            .await
            .unwrap();
        let request = hyper::Request::builder()
            .method("GET")
            .uri("/capture")
            .header("host", server_name)
            .body(Full::new(Bytes::new()))
            .unwrap();
        let counted = Arc::new(AtomicUsize::new(0));
        let response = dispatch(
            tls,
            request,
            counted.clone(),
            Instant::now() + std::time::Duration::from_secs(5),
        )
        .await
        .unwrap();
        origin.await.unwrap();
        assert!(response.response_complete && counted.load(Ordering::Relaxed) > 0);
        assert_eq!(response.body, b"hello!");
        let got: Vec<_> = response
            .trailers
            .iter()
            .map(|h| (h.name.as_str(), h.value.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![("x-late-field", "first"), ("x-late-field", "second")]
        );
    }
}
