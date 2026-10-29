//! One pinned, verified TLS origin connection. No redirects, retries, decompression or early release.
use crate::exchange::wire::{HttpHeader, InstallationExchangeResponse as Response};
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

#[derive(Clone, Deserialize)]
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
    tls: Arc<ClientConfig>,
}

impl Route {
    pub fn admit(self) -> Result<AdmittedRoute> {
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
            tls: Arc::new(tls),
        })
    }
}

impl AdmittedRoute {
    pub fn pin(&self) -> (String, IpAddr) {
        (self.spec.host.clone(), self.spec.connect_ip)
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

    pub async fn connect(
        &self,
        origin: ExchangeOrigin<'_>,
        stop_at: Instant,
    ) -> Result<TlsStream<SocketGate<TcpStream>>> {
        let s = &self.spec;
        // The Box connection thread performs one bounded dial, with no DNS or second socket.
        let stream = origin.connect(s.connect_ip, stop_at.into_std())?;
        stream.set_nonblocking(true)?;
        let stream = TcpStream::from_std(stream)?;
        let tls = TlsConnector::from(self.tls.clone())
            .connect(
                ServerName::try_from(s.host.clone())?,
                SocketGate::new(stream),
            )
            .await?;
        Ok(tls)
    }
}

/// Admit only the supported Responses headers; reject everything else before OCE classification.
/// Rebuild authority and framing from the bound Box target.
/// These exact remaining headers and body are both signed for OCE classification and sent to origin.
pub fn capture(req: &DelegatedRequest<'_>) -> Result<Vec<HttpHeader>> {
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
    let mut seen = std::collections::BTreeSet::new();
    for (name, value) in req.headers.iter() {
        let name = name.to_ascii_lowercase();
        ensure!(seen.insert(name.clone()), "duplicate Responses header");
        match name.as_str() {
            "host" => {} // Rebuilt from Box's bound target, never the SDK's authority.
            "content-type" | "accept" => headers.push(HttpHeader {
                name,
                value: value.to_owned(),
            }),
            // Public nonsecret SDK configuration only. Never sign, forward or persist it.
            "authorization" => ensure!(
                value == "Bearer oce-placeholder",
                "unsupported Responses authorization"
            ),
            // Explicit informational fields emitted by the Node SDK and its Fetch transport.
            // None confers authority or changes the canonical operation. Do not broaden this
            // to a prefix match: organization, project and unknown fields must still refuse.
            "user-agent"
            | "x-stainless-arch"
            | "x-stainless-lang"
            | "x-stainless-os"
            | "x-stainless-package-version"
            | "x-stainless-retry-count"
            | "x-stainless-runtime"
            | "x-stainless-runtime-version"
            | "x-stainless-timeout"
            | "accept-encoding"
            | "accept-language"
            | "sec-fetch-mode" => {}
            _ => anyhow::bail!("unsupported Responses header"),
        }
    }
    Ok(headers)
}

pub async fn dispatch<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    mut tls: TlsStream<SocketGate<S>>,
    request: hyper::Request<Full<Bytes>>,
    counted: Arc<AtomicUsize>,
    start_by: Instant,
) -> Result<Response> {
    tls.get_mut().0.start_by = Some(start_by);
    let io = PlaintextCounter { tls, counted };
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

/// Count plaintext custody separately from actual socket admission.
struct PlaintextCounter<S> {
    tls: TlsStream<S>,
    counted: Arc<AtomicUsize>,
}
impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for PlaintextCounter<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Cx<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
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
impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for PlaintextCounter<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Cx<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.tls).poll_read(cx, buf)
    }
}

/// Unarmed during TLS authentication, then armed at the final permit. Every
/// pending socket write is checked again on wake; accepting plaintext in rustls
/// cannot consume the send-start window. Flush and shutdown cannot bypass it.
pub struct SocketGate<S> {
    inner: S,
    start_by: Option<Instant>,
    started: bool,
}
impl<S> SocketGate<S> {
    fn new(inner: S) -> Self {
        Self {
            inner,
            start_by: None,
            started: false,
        }
    }
    fn check(&self) -> io::Result<()> {
        if !self.started
            && self
                .start_by
                .is_some_and(|deadline| Instant::now() >= deadline)
        {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "origin send-start authorization expired",
            ))
        } else {
            Ok(())
        }
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for SocketGate<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Cx<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.check()?;
        let n = std::task::ready!(Pin::new(&mut self.inner).poll_write(cx, buf))?;
        if self.start_by.is_some() && n > 0 {
            self.started = true;
        }
        Poll::Ready(Ok(n))
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Cx<'_>) -> Poll<io::Result<()>> {
        self.check()?;
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Cx<'_>) -> Poll<io::Result<()>> {
        self.check()?;
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
impl<S: AsyncRead + Unpin> AsyncRead for SocketGate<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Cx<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
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
            .admit()
            .unwrap();
        assert_eq!(
            admitted.spec.host, "origin.example",
            "verify the TLS host, never replace it with the pin"
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
            .connect(
                ServerName::try_from(server_name).unwrap(),
                SocketGate::new(tcp),
            )
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

    #[tokio::test]
    async fn expired_first_write_authority_delivers_no_decrypted_application_bytes() {
        deadline_case(false).await;
    }

    #[tokio::test]
    async fn tls_buffering_cannot_write_after_backpressure_outlives_the_permit() {
        deadline_case(true).await;
    }

    struct Backpressure {
        socket: TcpStream,
        blocked: Arc<std::sync::atomic::AtomicBool>,
        pending: Arc<tokio::sync::Notify>,
        waker: Arc<std::sync::Mutex<Option<std::task::Waker>>>,
    }
    impl AsyncWrite for Backpressure {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Cx<'_>,
            bytes: &[u8],
        ) -> Poll<io::Result<usize>> {
            if self.blocked.load(Ordering::SeqCst) {
                *self.waker.lock().unwrap() = Some(cx.waker().clone());
                self.pending.notify_one();
                return Poll::Pending;
            }
            Pin::new(&mut self.socket).poll_write(cx, bytes)
        }
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Cx<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.socket).poll_flush(cx)
        }
        fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Cx<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.socket).poll_shutdown(cx)
        }
    }
    impl AsyncRead for Backpressure {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Cx<'_>,
            bytes: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Pin::new(&mut self.socket).poll_read(cx, bytes)
        }
    }

    async fn deadline_case(backpressure: bool) {
        let ck = rcgen::generate_simple_self_signed(vec!["origin.test".into()]).unwrap();
        let cert = ck.cert.der().clone();
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.clone()],
                PrivatePkcs8KeyDer::from(ck.signing_key.serialize_der()).into(),
            )
            .unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let origin = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut tls = TlsAcceptor::from(Arc::new(config))
                .accept(tcp)
                .await
                .unwrap();
            // EOF proves no data; any decrypted prefix fails the assertion below.
            let mut bytes = vec![0; 65536];
            let n = tls.read(&mut bytes).await.unwrap_or(0);
            bytes.truncate(n);
            bytes
        });
        let mut roots = RootCertStore::empty();
        roots.add(cert).unwrap();
        let config = ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let blocked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let pending = Arc::new(tokio::sync::Notify::new());
        let waker = Arc::new(std::sync::Mutex::new(None));
        let socket = Backpressure {
            socket: TcpStream::connect(address).await.unwrap(),
            blocked: blocked.clone(),
            pending: pending.clone(),
            waker: waker.clone(),
        };
        let tls = TlsConnector::from(Arc::new(config))
            .connect(
                ServerName::try_from("origin.test").unwrap(),
                SocketGate::new(socket),
            )
            .await
            .unwrap();
        let request = hyper::Request::builder()
            .method("POST")
            .uri("/v1/responses")
            .body(Full::new(Bytes::from_static(b"must not leave")))
            .unwrap();
        let counted = Arc::new(AtomicUsize::new(0));
        blocked.store(backpressure, Ordering::SeqCst);
        let deadline = if backpressure {
            Instant::now() + std::time::Duration::from_millis(100)
        } else {
            Instant::now() - std::time::Duration::from_millis(1)
        };
        let resume = async {
            if backpressure {
                tokio::time::timeout(std::time::Duration::from_secs(2), pending.notified())
                    .await
                    .unwrap();
                tokio::time::sleep_until(deadline + std::time::Duration::from_millis(10)).await;
                blocked.store(false, Ordering::SeqCst);
                waker.lock().unwrap().take().unwrap().wake();
            }
        };
        let (response, ()) =
            tokio::join!(dispatch(tls, request, counted.clone(), deadline), resume);
        assert!(response.is_err());
        if backpressure {
            assert!(
                counted.load(Ordering::Relaxed) > 0,
                "TLS accepted buffered plaintext before the socket became writable"
            );
        }
        assert!(origin.await.unwrap().is_empty());
    }
}
