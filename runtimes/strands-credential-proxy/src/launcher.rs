//! Native host entry point. Box owns hardening, runtime, containment and the original writer.
use egress_gateway::{DelegatedFailure, DelegatedReply, DelegatedRequest, RequestExchange};
use std::{
    io,
    path::Path,
    process::ExitCode,
    sync::{Arc, OnceLock},
};
use strands_credential_proxy::CredentialProxy;

const BOX_CONFIG: &str = "/etc/strands-box/box.toml";
const INSTALLATION: &str = "/etc/oce-protected-sender/installation.json";
const PINS: &str = "/etc/oce-protected-sender/pins.json";

#[derive(Default)]
struct EnrolledExchange(OnceLock<Arc<CredentialProxy>>);

impl RequestExchange for EnrolledExchange {
    fn exchange(&self, request: DelegatedRequest<'_>) -> Result<DelegatedReply, DelegatedFailure> {
        self.0
            .get()
            .ok_or(DelegatedFailure::Unavailable)?
            .exchange(request)
    }
}

fn main() -> ExitCode {
    // This is a distinct trusted executable, not a workload-selectable Box mode.
    if std::env::args_os().len() != 1 {
        eprintln!("oce-protected-box: no arguments accepted");
        return ExitCode::FAILURE;
    }
    let exchange = Arc::new(EnrolledExchange::default());
    let initialize = exchange.clone();
    // Nonsecret routing input only. Defer errors to the hardened startup callback.
    // No key, bearer, channel or network is accessed before Box applies hardening.
    let pins: Result<Vec<(String, std::net::IpAddr)>, ()> =
        std::fs::read(PINS).map_err(|_| ()).and_then(|bytes| {
            if bytes.len() > 4096 {
                return Err(());
            }
            serde_json::from_slice(&bytes).map_err(|_| ())
        });
    let box_pins = pins.as_ref().cloned().unwrap_or_default();
    strands_box::run(
        BOX_CONFIG.into(),
        Vec::new(),
        strands_box::RunOptions {
            request_exchange: Some(exchange),
            request_exchange_pins: box_pins,
            on_ready: Some(Box::new(move || {
                // Only Box calls this, after hardening and inside its runtime. Do not
                // read keys, create channels or start another runtime before this point.
                let sender = strands_credential_proxy::load(Path::new(INSTALLATION))
                    .map_err(|_| io::Error::other("protected sender installation unavailable"))?;
                if pins.as_ref().ok() != Some(&vec![sender.origin_pin()]) {
                    return Err(io::Error::other(
                        "protected sender pin enrollment unavailable",
                    ));
                }
                initialize
                    .0
                    .set(sender)
                    .map_err(|_| io::Error::other("protected sender already initialized"))
            })),
            ..Default::default()
        },
    )
}
