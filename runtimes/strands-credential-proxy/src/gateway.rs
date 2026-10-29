//! Reference transport for a trusted host with an already enrolled execution.
//! This starts no workload and supplies no containment or enrollment authority.
use anyhow::{Result, ensure};
use egress_gateway::{MitmConfig, MitmInterceptor, ResponseLimits};
use policy::{EgressPolicyInterceptor, GovernedBox, Policy, PolicyEngine, Principal};
use serde::Deserialize;
use std::{
    fs,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::Arc,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Gateway {
    sender: PathBuf,
    policy: PathBuf,
    history: PathBuf,
    trust_directory: PathBuf,
    listen: SocketAddr,
    // This name is supplied by the trusted host, never by a request header.
    governed_box: String,
    dns: Vec<(String, IpAddr)>,
}

#[tokio::main(worker_threads = 2)]
async fn main() -> Result<()> {
    let path = std::env::args_os()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("expected gateway configuration"))?;
    let config: Gateway = serde_json::from_slice(&fs::read(path)?)?;
    ensure!(
        config.listen.ip().is_loopback(),
        "reference gateway must bind loopback"
    );
    let sender = strands_credential_proxy::load(&config.sender)?;
    let engine = PolicyEngine::open(
        vec![Policy {
            origin: config.policy.clone(),
            text: fs::read_to_string(config.policy)?,
        }],
        &config.history,
    )?;
    let effects = EgressPolicyInterceptor::into_handle(
        Arc::new(engine),
        Principal::agent(),
        GovernedBox::assigned(&config.governed_box),
    );
    let gateway = MitmInterceptor::start_with_request_exchange(
        MitmConfig {
            bind_addr: config.listen,
            intercept_ca_dir: Some(config.trust_directory),
            dns_overrides: config.dns,
            max_connections: 32,
            response_limits: ResponseLimits {
                max_body_bytes: 1024 * 1024,
            },
            upstream_read_deadline: std::time::Duration::from_secs(30),
            ..MitmConfig::default()
        },
        effects,
        sender,
    )?;
    println!(
        "{}",
        serde_json::json!({"port": gateway.port(), "ca": gateway.intercept_ca_path()})
    );
    tokio::signal::ctrl_c().await?;
    drop(gateway);
    Ok(())
}
