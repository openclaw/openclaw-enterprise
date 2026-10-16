//! Fail closed if an execution's private temporal history disappears.
//! The controller supplies a new PVC and an empty bearer only for initial enrollment.
use anyhow::{Context, Result, ensure};
use policy::{EgressPolicyInterceptor, GovernedBox, Policy, PolicyEngine, Principal};
use std::{
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Write},
    path::Path,
    sync::Arc,
};

pub fn load(
    dir: &Path,
    policy_path: &Path,
    dogwood: String,
    sandbox: &str,
    peer: &str,
    hash: &str,
    initial_enrollment: bool,
) -> Result<Arc<dyn egress_gateway::EffectInterceptor>> {
    let db = dir.join("dogwood.redb");
    let marker = dir.join("execution-history-v1");
    let identity = serde_json::to_vec(&[sandbox, peer, hash])?;
    match OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&marker)
    {
        Ok(mut file) => {
            // A failed first initialization may leave the marker. Never silently start it over.
            ensure!(
                initial_enrollment && !db.exists(),
                "missing execution history guard; refusing reenrollment with empty history"
            );
            file.write_all(&identity)?;
            file.sync_all()?;
            File::open(dir)?.sync_all()?;
        }
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {
            ensure!(
                fs::read(&marker)? == identity,
                "execution, key or policy changed for existing history"
            );
            let meta =
                fs::symlink_metadata(&db).context("established execution lost Dogwood history")?;
            ensure!(
                meta.is_file() && meta.len() > 0,
                "established execution has empty or invalid Dogwood history"
            );
        }
        Err(e) => {
            return Err(e).context("execution history directory must be private and writable");
        }
    }
    let engine = PolicyEngine::open_with_mcp_schemas(
        vec![Policy {
            origin: policy_path.into(),
            text: dogwood,
        }],
        &[],
        &db,
    )
    .context("load and recover private Dogwood policy history")?;
    Ok(EgressPolicyInterceptor::into_handle(
        Arc::new(engine),
        Principal::agent(),
        GovernedBox::assigned(sandbox),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use egress_gateway::{EffectAttempt, EffectOutcome};
    #[test]
    fn one_attempt_policy_remembers_an_uncertain_send_across_restart_and_rejects_lost_history() {
        let dir = tempfile::tempdir().unwrap();
        let p = include_str!("../policy/one-attempt.dw");
        let open = |initial| {
            load(
                dir.path(),
                Path::new("attempt-policy.dw"),
                p.into(),
                "exec",
                "key",
                "hash",
                initial,
            )
        };
        let attempt = EffectAttempt::HttpRequest {
            host: "example.test",
            port: 443,
            method: "POST",
            path: "/test",
            body_bytes: 10,
            intercepted: true,
            mcp: None,
        };
        let effects = open(true).unwrap();
        effects
            .intercept(&attempt)
            .expect("first attempt allowed")
            .record_outcome(EffectOutcome::Indeterminate { accepted_bytes: 10 })
            .unwrap();
        drop(effects);
        let effects = open(false).unwrap();
        assert!(
            effects.intercept(&attempt).is_err(),
            "second attempt, after restart, refused"
        );
        drop(effects);
        fs::remove_file(dir.path().join("dogwood.redb")).unwrap();
        assert!(
            open(true).is_err(),
            "lost history cannot be silently recreated"
        );
    }
}
