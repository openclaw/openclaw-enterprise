//! Execution-bound terminal sender for the Box hosted gateway.
//! The caller retains policy, containment and history; this library owns one origin exchange.
mod exchange;
mod origin;
mod selection;

use anyhow::{Context, Result, ensure};
use ring::signature::Ed25519KeyPair;
use serde::Deserialize;
use std::{fs, path::PathBuf, sync::Arc};
use zeroize::Zeroizing;

pub use exchange::CredentialProxy;

/// Trusted installation input, never accepted from a workload request.
/// The selected Driver must authenticate and acknowledge this exact execution before use.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    sandbox_id: String,
    instance_id: String,
    audience: String,
    authority_uri: String,
    authority_ca_path: PathBuf,
    exchange_seed_path: PathBuf,
    bearer_path: PathBuf,
    policy_hash: String,
    route: origin::Route,
}

/// Construct the sender inside the trusted host's Tokio runtime. No listener or sandbox is created.
/// Missing/unsupported installation data fails before Box can admit a workload.
pub fn load(path: &std::path::Path) -> Result<Arc<CredentialProxy>> {
    let bytes = fs::read(path).context("read protected sender installation")?;
    ensure!(bytes.len() <= 65536, "sender installation too large");
    let config: Config = serde_json::from_slice(&bytes)?;
    ensure!(
        !config.sandbox_id.is_empty()
            && !config.audience.is_empty()
            && uuid::Uuid::parse_str(&config.instance_id)?.get_version_num() == 4
            && config.policy_hash.len() == 64
            && config
                .policy_hash
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
        "invalid execution enrollment"
    );
    ensure!(
        config.route.method == "POST" && config.route.path == "/v1/responses",
        "only the enrolled Responses route is supported"
    );
    let seed = Zeroizing::new(fs::read(&config.exchange_seed_path)?);
    let key = Ed25519KeyPair::from_seed_unchecked(&seed)
        .map_err(|_| anyhow::anyhow!("expected execution Ed25519 seed"))?;
    let authority_ca = fs::read(&config.authority_ca_path)?;
    let route = config.route.clone().admit()?;
    let hash = config.policy_hash.clone();
    let sender = CredentialProxy::new(config, hash, key, route, authority_ca)?;
    sender.check_projection()?;
    Ok(Arc::new(sender))
}
