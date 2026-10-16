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

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Profile {
    Credential,
    NoMaterial,
}

pub struct Selected {
    pub authorize: Authorize,
    usable_ms: u64,
}

impl Selected {
    pub fn bind(
        resolution: Resolution,
        profile: Profile,
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
        let (id, handle, resolved_audience, usable_ms, selection) = match (profile, resolution) {
            (Profile::NoMaterial, Resolution::ReadyWithoutMaterial(ready)) => {
                // A *positive* no-material selection. Preserve empty injection, hash the empty input,
                // and explicitly require the second check for this operation, never a default false.
                (
                    ready.request_id,
                    ready.operation_handle,
                    ready.audience,
                    deadline_ms,
                    Selection::NoMaterialRequired(true),
                )
            }
            (Profile::Credential, Resolution::Ready(ready)) => {
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
        let no_material = matches!(a.selection, Some(Selection::NoMaterialRequired(true)));
        ensure!(
            Some(&permit.request_id) == a.context.as_ref().map(|c| &c.request_id)
                && permit.operation_handle == a.operation_handle
                && permit.credential_headers_sha256 == a.credential_headers_sha256
                && permit.no_material_required == no_material
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
    use prost::Message;
    use std::{env, fs, path::PathBuf};

    #[test]
    fn resolution_cannot_upgrade_downgrade_or_substitute_missing_material() {
        let ready = Resolution::ReadyWithoutMaterial(wire::HttpNoMaterialRequired {
            request_id: "test".into(),
            audience: "test".into(),
            operation_handle: b"test".to_vec(),
        });
        let missing = Resolution::Ready(wire::HttpCredentialMaterial::default());
        let bind = |profile, resolution| {
            Selected::bind(
                resolution,
                profile,
                &mut HeaderMap::new(),
                wire::RequestContext {
                    request_id: "test".into(),
                    ..Default::default()
                },
                "test",
                Timestamp::default(),
            )
        };
        assert!(
            bind(Profile::Credential, ready.clone()).is_err(),
            "no credentialed downgrade"
        );
        assert!(
            bind(Profile::NoMaterial, missing.clone()).is_err(),
            "no credential-free upgrade"
        );
        assert!(
            bind(Profile::Credential, missing).is_err(),
            "absent credential, not a credential-free selection"
        );
        let selected = bind(Profile::NoMaterial, ready).expect("positive no-material selection");
        let a = selected.authorize;
        assert_eq!(a.selection, Some(Selection::NoMaterialRequired(true)));
        assert_eq!(
            a.credential_headers_sha256,
            ring::digest::digest(&SHA256, b"").as_ref()
        );
    }

    #[test]
    fn credential_bearing_permit_cannot_be_acknowledged_as_no_material() {
        let deadline = wire_time_for_test();
        let custody = [9u8; 32];
        let evidence = wire::HttpCredentialEvidence {
            usable_until: Some(deadline),
            authority_evidence: b"fixture evidence".to_vec(),
            ..Default::default()
        };
        let ready = Resolution::Ready(wire::HttpCredentialMaterial {
            request_id: "test".into(),
            audience: "test".into(),
            operation_handle: b"handle".to_vec(),
            evidence: Some(evidence),
            credential_headers: vec![wire::HttpHeader {
                name: "authorization".into(),
                value: "fixture credential".into(),
            }],
        });
        let mut headers = HeaderMap::new();
        let selected = Selected::bind(
            ready,
            Profile::Credential,
            &mut headers,
            wire::RequestContext {
                request_id: "test".into(),
                ..Default::default()
            },
            "test",
            deadline,
        )
        .unwrap();
        assert_eq!(headers["authorization"], "fixture credential");
        assert!(matches!(
            selected.authorize.selection,
            Some(Selection::Evidence(_))
        ));
        let a = &selected.authorize;
        let mut permit = Permit {
            request_id: "test".into(),
            operation_handle: a.operation_handle.clone(),
            credential_headers_sha256: a.credential_headers_sha256.clone(),
            send_start_by: Some(deadline),
            response_custody: custody.to_vec(),
            no_material_required: false,
        };
        selected.check_permit(&permit, &custody).unwrap();
        permit.no_material_required = true;
        assert!(
            selected.check_permit(&permit, &custody).is_err(),
            "credentialed dispatch cannot accept credential-free acknowledgement"
        );
    }

    fn wire_time_for_test() -> Timestamp {
        let later = SystemTime::now().duration_since(UNIX_EPOCH).unwrap() + Duration::from_secs(10);
        Timestamp {
            seconds: later.as_secs() as i64,
            nanos: later.subsec_nanos() as i32,
        }
    }

    /// Called twice by the real peer test: produce the actual authorize protobuf, then check the
    /// real permit before its 1-second first-write deadline. This harness accepts no credentials.
    #[test]
    #[ignore = "invoked against the genuine signed peer by credential-free-opening.test.mjs"]
    fn portable_no_material_peer() {
        let dir = PathBuf::from(env::var_os("STRANDS_NO_MATERIAL_WIRE_DIR").unwrap());
        let read = |name: &str| fs::read(dir.join(name)).unwrap();
        let opening = wire::HttpCredentialResolveRequest::decode(&*read("opening")).unwrap();
        let reply = wire::HttpCredentialResolveResponse::decode(&*read("resolved")).unwrap();
        let resolution = reply.result.unwrap();
        assert!(
            matches!(&resolution, Resolution::ReadyWithoutMaterial(_)),
            "explicit selection, not missing credentials"
        );
        let mut headers = HeaderMap::new();
        let selected = Selected::bind(
            resolution,
            Profile::NoMaterial,
            &mut headers,
            opening.request.unwrap().context.unwrap(),
            &opening.audience,
            opening.deadline.unwrap(),
        )
        .unwrap();
        assert!(
            headers.is_empty(),
            "no injected credential, not even an empty header"
        );
        if !dir.join("permit").exists() {
            fs::write(dir.join("authorize"), selected.authorize.encode_to_vec()).unwrap();
            return;
        }
        let custody = opening.response_custody;
        let permit = Permit::decode(&*read("permit")).unwrap();
        selected
            .check_permit(&permit, &custody)
            .expect("actual no-material permit and its signed custody");
        let mut changed = permit.clone();
        changed.no_material_required = false;
        assert!(
            selected.check_permit(&changed, &custody).is_err(),
            "credentialed or older permit cannot authorize this"
        );
        let mut changed = permit.clone();
        changed.credential_headers_sha256 = vec![0; 32];
        assert!(
            selected.check_permit(&changed, &custody).is_err(),
            "digest of absence is required"
        );
        let mut changed = permit;
        changed.response_custody[0] ^= 1;
        assert!(
            selected.check_permit(&changed, &custody).is_err(),
            "different response sink refused"
        );
    }
}
