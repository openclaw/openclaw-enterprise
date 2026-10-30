//! Bind the authority's positive selection and final permit to the material profile of this route.
//! Missing, malformed or unavailable material can never turn a credentialed operation into a free send.
use crate::exchange::{
    timestamp_ms,
    wire::{
        self, HttpCredentialAuthorizeSendRequest as Authorize, HttpCredentialSendPermit as Permit,
        http_credential_authorize_send_request::Selection,
        http_credential_resolve_response::Result as Resolution,
    },
};
use anyhow::{Context, Result, ensure};
use hyper::header::{HeaderMap, HeaderName, HeaderValue};
use prost_types::Timestamp;
use ring::digest::{self, SHA256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::Instant;
use zeroize::Zeroizing;

pub struct Selected {
    pub authorize: Authorize,
    usable_ms: u64,
}

impl Selected {
    pub fn bind(
        resolution: Resolution,
        headers: &mut HeaderMap,
        context: wire::RequestContext,
        audience: &str,
        deadline: Timestamp,
    ) -> Result<Self> {
        // The bound Box request, not a workload header, supplies the origin and any eventual credential.
        ensure!(
            [
                "authorization",
                "cookie",
                "proxy-authorization",
                "x-api-key",
                "api-key"
            ]
            .iter()
            .all(|name| !headers.contains_key(*name)),
            "untrusted credential in captured request"
        );
        let deadline_ms = timestamp_ms(deadline)?;
        let mut digest = digest::Context::new(&SHA256);
        let (id, handle, resolved_audience, usable_ms, selection) = match resolution {
            Resolution::Ready(ready) => {
                let evidence = ready.evidence.context("missing material evidence")?;
                let until =
                    timestamp_ms(evidence.usable_until.context("missing material deadline")?)?;
                ensure!(
                    !evidence.authority_evidence.is_empty() && until <= deadline_ms,
                    "unbound material evidence"
                );
                let [field]: [_; 1] = ready
                    .credential_headers
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("expected one credential header"))?;
                let name = field.name;
                let credential = Zeroizing::new(field.value);
                ensure!(
                    matches!(name.as_str(), "authorization" | "api-key" | "x-api-key")
                        && !credential.is_empty(),
                    "unsupported or absent injected credential"
                );
                let mut value = HeaderValue::from_str(&credential)?;
                value.set_sensitive(true);
                for bytes in [name.as_bytes(), credential.as_bytes()] {
                    digest.update(&(bytes.len() as u64).to_be_bytes());
                    digest.update(bytes);
                }
                headers.insert(HeaderName::try_from(name)?, value);
                (
                    ready.request_id,
                    ready.operation_handle,
                    ready.audience,
                    until,
                    Selection::Evidence(evidence),
                )
            }
            _ => anyhow::bail!("authority selection differs from installed route material profile"),
        };
        ensure!(
            id == context.request_id && resolved_audience == audience && !handle.is_empty(),
            "selection not for this operation"
        );
        Ok(Self {
            usable_ms,
            authorize: Authorize {
                context: Some(context),
                operation_handle: handle,
                audience: audience.into(),
                deadline: Some(deadline),
                selection: Some(selection),
                credential_headers_sha256: digest.finish().as_ref().to_vec(),
            },
        })
    }

    pub fn check_permit(&self, permit: &Permit, custody: &[u8]) -> Result<Instant> {
        let a = &self.authorize;
        let start_ms = timestamp_ms(permit.send_start_by.context("no send-start deadline")?)?;
        ensure!(
            Some(&permit.request_id) == a.context.as_ref().map(|c| &c.request_id)
                && permit.operation_handle == a.operation_handle
                && permit.credential_headers_sha256 == a.credential_headers_sha256
                && !permit.no_material_required
                && custody.len() == 32
                && permit.response_custody == custody
                && start_ms <= self.usable_ms,
            "permit does not bind the captured operation, selected injection or its absence, deadline and custody"
        );
        let remaining =
            (UNIX_EPOCH + Duration::from_millis(start_ms)).duration_since(SystemTime::now())?;
        Ok(Instant::now() + remaining)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_route_refuses_no_material_and_a_substituted_custody() {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        let deadline = Timestamp {
            seconds: (now.as_secs() + 10) as i64,
            nanos: 0,
        };
        let context = wire::RequestContext {
            request_id: "operation".into(),
            ..Default::default()
        };
        let no_material = Resolution::ReadyWithoutMaterial(wire::HttpNoMaterialRequired::default());
        assert!(
            Selected::bind(
                no_material,
                &mut HeaderMap::new(),
                context.clone(),
                "authority",
                deadline
            )
            .is_err()
        );
        let resolution = Resolution::Ready(wire::HttpCredentialMaterial {
            request_id: context.request_id.clone(),
            audience: "authority".into(),
            operation_handle: b"handle".to_vec(),
            evidence: Some(wire::HttpCredentialEvidence {
                usable_until: Some(deadline),
                authority_evidence: b"opaque".to_vec(),
                ..Default::default()
            }),
            credential_headers: vec![wire::HttpHeader {
                name: "authorization".into(),
                value: "synthetic material".into(),
            }],
        });
        let selected = Selected::bind(
            resolution,
            &mut HeaderMap::new(),
            context,
            "authority",
            deadline,
        )
        .unwrap();
        let custody = [7u8; 32];
        let mut permit = Permit {
            request_id: "operation".into(),
            operation_handle: b"handle".to_vec(),
            credential_headers_sha256: selected.authorize.credential_headers_sha256.clone(),
            send_start_by: Some(deadline),
            response_custody: custody.to_vec(),
            no_material_required: false,
        };
        assert!(selected.check_permit(&permit, &custody).is_ok());
        permit.response_custody[0] ^= 1;
        assert!(selected.check_permit(&permit, &custody).is_err());
        permit.response_custody = custody.to_vec();
        permit.credential_headers_sha256[0] ^= 1;
        assert!(selected.check_permit(&permit, &custody).is_err());
    }
}
