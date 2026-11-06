// Test module for stock OpenShell v0.1.7's openshell-supervisor-network crate.
// See docs/testing/postgresql.md. The fixture supplies Gateway inventory and a
// TLS destination; authorization and credential resolution run across the wire.
use super::{L7EvalContext, relay_with_inspection};
use crate::l7::token_grant_injection::SpiffeTokenGrantResolver;
use crate::opa::{NetworkInput, OpaEngine};
use crate::token_grant::SandboxInstanceTokenGrants;
use openshell_core::{proto, provider_credentials::ProviderCredentialState};
use openshell_extension_core::BearerTokenSlot;
use openshell_supervisor_middleware::{ChainRunner, MiddlewareRegistry};
use serde::Deserialize;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sender {
    broker_url: String,
    broker_ca_pem: String,
    token_url: String,
    audience: String,
    supervisor_token: String,
    sandbox_id: String,
    sandbox_name: String,
    workspace: String,
    middleware_name: String,
    binding_config: serde_json::Value,
    origin_host: String,
    origin_port: u16,
    origin_address: std::net::SocketAddr,
    origin_ca_pem: String,
    path: String,
}

#[derive(Deserialize)]
struct Dispatch {
    id: String,
    body: serde_json::Value,
}

#[tokio::test]
#[ignore = "requires the PostgreSQL saved-account fixture and a SPIFFE Workload API socket"]
async fn external_stock_sender() {
    let file =
        std::fs::File::open(std::env::var_os("OPENSHELL_TEST_BROKER_REQUEST").unwrap()).unwrap();
    use std::os::unix::fs::PermissionsExt;
    let metadata = file.metadata().unwrap();
    assert!(
        metadata.is_file()
            && metadata.len() < 256 * 1024
            && metadata.permissions().mode() & 0o077 == 0
    );
    let input: Arc<Sender> = Arc::new(serde_json::from_reader(file).unwrap());
    let binding = input.binding_config["binding_id"].as_str().unwrap();
    let registry = MiddlewareRegistry::connect_services_authenticated(
        vec![],
        vec![proto::SupervisorMiddlewareService {
            name: input.middleware_name.clone(),
            grpc_endpoint: input.broker_url.clone(),
            audience: input.audience.clone(),
            tls_ca_cert_pem: input.broker_ca_pem.as_bytes().to_vec(),
            max_payload_bytes: 65536,
            request_timeout: Some(prost_types::Duration {
                seconds: 10,
                nanos: 0,
            }),
            binding_policy: proto::SupervisorMiddlewareBindingPolicy::Exact.into(),
            bindings: vec![proto::SupervisorMiddlewareBinding::HttpRequestPreCredentials.into()],
            ..Default::default()
        }],
        &HashMap::from([(
            input.middleware_name.clone(),
            BearerTokenSlot::new(&input.supervisor_token, i64::MAX).unwrap(),
        )]),
    )
    .await
    .expect("authenticate the selected middleware");

    // Let both test tools reach OCC so only the Agent slot policy can distinguish
    // them. A denied request must never reach the test HTTPS service.
    let policy = serde_json::json!({
        "network_middlewares": {"account": {"middleware":input.middleware_name, "on_error":"fail_closed", "endpoints":{"include":[input.origin_host]}, "config":input.binding_config}},
        "network_policies":{"mcp":{"name":"mcp","endpoints":[{
          "host":input.origin_host, "port":input.origin_port, "path":input.path, "protocol":"mcp",
          "enforcement":"enforce", "token_grant_owner":"reports", "mcp":{"versions":["2025-11-25"]},
          "rules":[{"allow":{"method":"tools/call","tool":"list_reports"}},{"allow":{"method":"tools/call","tool":"delete_reports"}}]
        }],"binaries":[{"path":"/usr/bin/node"}]}}
    });
    let engine = Arc::new(
        OpaEngine::from_strings(
            include_str!("../../../data/sandbox-policy.rego"),
            &policy.to_string(),
        )
        .unwrap(),
    );
    engine.set_middleware_runner_for_tests(ChainRunner::from_registry(registry));
    let workload = NetworkInput {
        host: input.origin_host.clone(),
        port: input.origin_port,
        binary_path: "/usr/bin/node".into(),
        binary_sha256: "fixture".into(),
        ancestors: vec![],
        cmdline_paths: vec![],
    };
    let (cfg, generation) = engine
        .query_endpoint_config_with_generation(&workload)
        .unwrap();
    let config = crate::l7::parse_l7_config(&cfg.unwrap()).unwrap();
    let credential = proto::ProviderProfileCredential {
        name: "access_token".into(),
        auth_style: "bearer".into(),
        header_name: "Authorization".into(),
        token_grant_owners: vec!["reports".into()],
        token_grant: Some(proto::ProviderCredentialTokenGrant {
            token_endpoint: input.token_url.clone(),
            jwt_svid_audience: input.token_url.clone(),
            audience: binding.into(),
            grant_type: proto::ProviderCredentialTokenGrantType::ClientCredentials.into(),
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer".into(),
            cache_ttl: Some(prost_types::Duration {
                seconds: 0,
                nanos: 0,
            }),
            ..Default::default()
        }),
        ..Default::default()
    };
    let provider_key = format!(
        "{}\t{}\t{}\treports:access_token",
        input.origin_host, input.origin_port, input.path
    );
    let ctx = L7EvalContext {
        host: input.origin_host.clone(),
        port: input.origin_port,
        workspace: input.workspace.clone(),
        request_default_port: Some(443),
        binary_path: "/usr/bin/node".into(),
        policy_name: "mcp".into(),
        provider_credentials: Some(ProviderCredentialState::from_environment(
            1,
            HashMap::new(),
            HashMap::new(),
            HashMap::from([(provider_key, credential)]),
        )),
        token_grant_resolver: Some(Arc::new(SpiffeTokenGrantResolver::new(
            SandboxInstanceTokenGrants::new(
                None,
                Some(input.sandbox_id.clone()),
                std::env::var_os("OPENSHELL_TEST_SPIFFE_SOCKET").map(Into::into),
            ),
        ))),
        ..Default::default()
    };
    openshell_ocsf::ctx::bind_thread_ctx(Some(Arc::new(openshell_ocsf::EventContext {
        sandbox_id: input.sandbox_id.clone(),
        sandbox_name: input.sandbox_name.clone(),
        ..(*openshell_ocsf::ctx::ctx()).clone()
    })));
    let mut commands = BufReader::new(tokio::io::stdin()).lines();
    let mut running = tokio::task::JoinSet::new();
    while let Some(line) = commands.next_line().await.unwrap() {
        let request: Dispatch = serde_json::from_str(&line).unwrap();
        let input = input.clone();
        let ctx = ctx.clone();
        let config = config.clone();
        let tunnel = engine.clone_engine_for_tunnel(generation).unwrap();
        running.spawn(async move {
            // Every request uses the same Sandbox cache but its own actual HTTP
            // exchange, allowing a second call while the first waits for refresh.
            let trust = crate::l7::tls::build_upstream_client_config(&input.origin_ca_pem).unwrap();
            let tcp = tokio::net::TcpStream::connect(input.origin_address).await.unwrap();
            let name = rustls::pki_types::ServerName::try_from(input.origin_host.clone()).unwrap();
            let mut origin = tokio_rustls::TlsConnector::from(trust)
                .connect(name, tcp)
                .await
                .expect("verify the test resource TLS certificate");
            let (mut caller, mut supervisor) = tokio::io::duplex(65536);
            let relay = tokio::spawn(async move {
                relay_with_inspection(&config, tunnel, &mut supervisor, &mut origin, &ctx).await
            });
            let body = request.body.to_string();
            let https_request = format!(
                concat!(
                    "POST {} HTTP/1.1\r\nHost: {}:{}\r\nAuthorization: Bearer workload-value\r\n",
                    "Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n",
                    "MCP-Protocol-Version: 2025-11-25\r\nContent-Length: {}\r\n\r\n{}"
                ),
                input.path, input.origin_host, input.origin_port, body.len(), body,
            );
            caller.write_all(https_request.as_bytes()).await.unwrap();
            let mut status_line = Vec::new();
            tokio::time::timeout(Duration::from_secs(30), async {
                while !status_line.ends_with(b"\r\n") && status_line.len() < 512 {
                    status_line.push(caller.read_u8().await.expect("downstream HTTP status"));
                }
            })
            .await
            .unwrap();
            let status = std::str::from_utf8(&status_line)
                .unwrap()
                .split_ascii_whitespace()
                .nth(1)
                .expect("HTTP status code")
                .parse::<u16>()
                .unwrap();
            println!("OPENSHELL_TEST_HTTP_STATUS={} {status}", request.id);
            drop(caller);
            relay.abort();
        });
    }
    while let Some(done) = running.join_next().await {
        done.unwrap();
    }
}
