// Included only in the published OpenShell sender's request_credential_tests module.
// Accept the actual worker TLS stream so its selectors, discovery, arguments and replies
// all traverse the native inspected relay and authenticated terminal middleware.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRelay {
    broker_url: String,
    broker_ca_pem: String,
    audience: String,
    supervisor_token: String,
    middleware_name: String,
    sandbox_id: String,
    sandbox_name: String,
    workspace: String,
    origin_host: String,
    origin_port: u16,
    origin_address: std::net::SocketAddr,
    ca_pem: String,
    certificate_pem: String,
    private_key_pem: String,
    policy_name: String,
    binary: String,
    policy: serde_json::Value,
}

#[tokio::test]
#[ignore = "requires the browser-account worker, OCC authority and HTTPS recipient"]
async fn external_browser_account_worker_stream() {
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, pem::PemObject};
    let events = openshell_ocsf::test_support::OcsfCapture::default();
    let _trace = events.install();
    tokio::spawn(async move {
        let mut offset = 0;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let snapshot = events.json_events();
            for item in &snapshot[offset..] {
                let reason = item["status_detail"].as_str().unwrap_or("");
                if !reason.is_empty()
                    && reason.len() < 80
                    && reason
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_')
                {
                    eprintln!("OCE_RELAY_REASON={reason}");
                }
            }
            offset = snapshot.len();
        }
    });
    let input: WorkerRelay =
        serde_json::from_reader(std::io::stdin()).expect("read local fixture configuration");
    let registry = authenticated_registry(
        &input.middleware_name,
        input.broker_url,
        input.broker_ca_pem,
        &input.audience,
        &input.supervisor_token,
    )
    .await;
    let engine = OpaEngine::from_strings(
        include_str!("../../../data/sandbox-policy.rego"),
        &input.policy.to_string(),
    )
    .unwrap();
    engine.set_middleware_runner_for_tests(ChainRunner::from_registry(registry));
    let workload = NetworkInput {
        host: input.origin_host.clone(),
        port: input.origin_port,
        binary_path: input.binary.clone().into(),
        binary_sha256: "fixture".into(),
        ancestors: vec![],
        cmdline_paths: vec![],
    };
    let (config, generation) = engine
        .query_endpoint_config_with_generation(&workload)
        .unwrap();
    let config = Arc::new(crate::l7::parse_l7_config(&config.unwrap()).unwrap());
    let tls = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            CertificateDer::pem_slice_iter(input.certificate_pem.as_bytes())
                .collect::<Result<Vec<_>, _>>()
                .unwrap(),
            PrivateKeyDer::from_pem_slice(input.private_key_pem.as_bytes()).unwrap(),
        )
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
    let upstream = tokio_rustls::TlsConnector::from(
        crate::l7::tls::build_upstream_client_config(&input.ca_pem).unwrap(),
    );
    let host = ServerName::try_from(input.origin_host.clone()).unwrap();
    let ctx = Arc::new(L7EvalContext {
        host: input.origin_host,
        port: input.origin_port,
        workspace: input.workspace,
        request_default_port: Some(443),
        binary_path: input.binary,
        policy_name: input.policy_name,
        ..Default::default()
    });
    openshell_ocsf::ctx::bind_thread_ctx(Some(Arc::new(openshell_ocsf::EventContext {
        sandbox_id: input.sandbox_id,
        sandbox_name: input.sandbox_name,
        ..(*openshell_ocsf::ctx::ctx()).clone()
    })));
    let clients = tokio::net::TcpListener::bind(("127.0.0.1", input.origin_port))
        .await
        .unwrap();
    println!("OCE_BROWSER_ACCOUNT_RELAY_READY");
    loop {
        let (socket, _) = clients.accept().await.unwrap();
        let listener = acceptor.clone();
        let connector = upstream.clone();
        let peer = host.clone();
        let policy = config.clone();
        let ctx = ctx.clone();
        let evaluator = engine.clone_engine_for_tunnel(generation).unwrap();
        tokio::spawn(async move {
            let mut worker = listener.accept(socket).await.unwrap();
            let origin = tokio::net::TcpStream::connect(input.origin_address)
                .await
                .unwrap();
            let mut origin = connector.connect(peer, origin).await.unwrap();
            let _ = relay_with_inspection(&policy, evaluator, &mut worker, &mut origin, &ctx).await;
        });
    }
}
