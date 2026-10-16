//! Omit native Codex's optional Git workspace telemetry, in both of its mirrored representations.
//! This is a narrow privacy projection, not admission. Unknown turn metadata remains for OCE to deny.
use crate::exchange::wire::HttpHeader;
use bytes::Bytes;
use serde::{
    Deserialize,
    de::{self, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Value, value::RawValue};
use std::{
    collections::{BTreeMap, HashSet},
    fmt,
};

/// The *same* captured bytes and ordered headers go to signed Credential Proxy resolution and origin send.
pub struct Capture {
    pub body: Bytes,
    pub headers: Vec<HttpHeader>,
}

impl Capture {
    pub fn new(
        body: &[u8],
        mut headers: Vec<HttpHeader>,
        inference_responses: bool,
    ) -> Result<Self, ()> {
        let body = if inference_responses {
            project(body, &mut headers)?
        } else {
            Bytes::copy_from_slice(body)
        };
        Ok(Self { body, headers })
    }
}

const TURN: &str = "x-codex-turn-metadata";
const MAX_TURN_BYTES: usize = 8192; // The unchanged Responses provider's client metadata bound.

/// Errors deliberately carry no inputs, parser messages or values. Reject ambiguity, don't repair it.
fn project(body: &[u8], headers: &mut [HttpHeader]) -> Result<Bytes, ()> {
    if body.len() > crate::origin::BODY_LIMIT {
        return Err(());
    }
    let mut mirrors = headers
        .iter_mut()
        .filter(|h| h.name.eq_ignore_ascii_case(TURN));
    let mirror = mirrors.next();
    if mirrors.next().is_some() {
        return Err(());
    }

    // Reject duplicate keys, including escape-equivalent spellings, at *any* depth before rewriting.
    serde_json::from_slice::<UniqueJson>(body).map_err(|_| ())?;
    let envelope: Envelope = serde_json::from_slice(body).map_err(|_| ())?;
    let Some(raw) = envelope.client_metadata.and_then(|m| m.turn) else {
        return if mirror.is_none() {
            Ok(Bytes::copy_from_slice(body))
        } else {
            Err(())
        };
    };
    let text: String = serde_json::from_str(raw.get()).map_err(|_| ())?;
    if text.len() > MAX_TURN_BYTES || mirror.as_ref().is_some_and(|h| h.value != text) {
        return Err(());
    }

    serde_json::from_str::<UniqueJson>(&text).map_err(|_| ())?;
    let mut turn: BTreeMap<String, &RawValue> = serde_json::from_str(&text).map_err(|_| ())?;
    let Some(workspaces) = turn.remove("workspaces") else {
        return Ok(Bytes::copy_from_slice(body));
    };

    // Native git_workspaces inserts exactly one absolute repo root, with known optional fields.
    // Reject a missing mirror, unknown workspace keys or new shapes; never sign a body-only projection.
    let mirror = mirror.ok_or(())?;
    known_workspace(workspaces)?;
    let clean = serde_json::to_string(&turn).map_err(|_| ())?; // other field values stay raw
    let encoded = serde_json::to_vec(&clean).map_err(|_| ())?;

    // RawValue borrows precisely the targeted JSON string token. Splice only that token, preserving
    // every byte of input, tool schema, numerical literal, whitespace, etc. outside the turn metadata.
    let token = raw.get().as_bytes();
    let start = (token.as_ptr() as usize)
        .checked_sub(body.as_ptr() as usize)
        .ok_or(())?;
    let end = start.checked_add(token.len()).ok_or(())?;
    if body.get(start..end) != Some(token) {
        return Err(());
    }
    let mut projected = Vec::with_capacity(body.len() - token.len() + encoded.len());
    projected.extend_from_slice(&body[..start]);
    projected.extend_from_slice(&encoded);
    projected.extend_from_slice(&body[end..]);
    mirror.value = clean; // same content, not a separately reconstructed header
    Ok(projected.into())
}

#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(borrow)]
    client_metadata: Option<ClientMetadata<'a>>,
}
#[derive(Deserialize)]
struct ClientMetadata<'a> {
    #[serde(borrow, rename = "x-codex-turn-metadata")]
    turn: Option<&'a RawValue>,
}

fn known_workspace(raw: &RawValue) -> Result<(), ()> {
    let workspaces: Value = serde_json::from_str(raw.get()).map_err(|_| ())?;
    let map = workspaces.as_object().filter(|m| m.len() == 1).ok_or(())?;
    let (root, fields) = map.iter().next().ok_or(())?;
    let bounded = |s: &str, n| !s.is_empty() && s.len() <= n && !s.chars().any(char::is_control);
    if !root.starts_with('/') || !bounded(root, 4096) {
        return Err(());
    }
    let fields = fields.as_object().filter(|m| !m.is_empty()).ok_or(())?;
    for (key, v) in fields {
        let known = match key.as_str() {
            "associated_remote_urls" => v.as_object().is_some_and(|m| {
                m.len() <= 32
                    && m.iter().all(|(k, v)| {
                        bounded(k, 255) && v.as_str().is_some_and(|url| bounded(url, 4096))
                    })
            }),
            "latest_git_commit_hash" => v.as_str().is_some_and(|s| {
                matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
            }),
            "has_changes" => v.is_boolean(),
            _ => false,
        };
        if !known {
            return Err(());
        }
    }
    Ok(())
}

/// serde_json normally resolves duplicate keys to their last value. Walk the bounded JSON once with
/// its normal recursion limit, checking decoded keys, without collecting a second copy of the request.
struct UniqueJson;
impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D: de::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(UniqueJson)
    }
}
impl<'de> Visitor<'de> for UniqueJson {
    type Value = Self;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("unambiguous bounded JSON")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut m: M) -> Result<Self, M::Error> {
        let mut keys = HashSet::new();
        while let Some(key) = m.next_key::<String>()? {
            if !keys.insert(key) {
                return Err(de::Error::custom("ambiguous object"));
            }
            m.next_value::<Self>()?;
        }
        Ok(self)
    }
    fn visit_seq<S: SeqAccess<'de>>(self, mut s: S) -> Result<Self, S::Error> {
        while s.next_element::<Self>()?.is_some() {}
        Ok(self)
    }
    fn visit_bool<E>(self, _: bool) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_u64<E>(self, _: u64) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_i64<E>(self, _: i64) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_f64<E>(self, _: f64) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_str<E>(self, _: &str) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_unit<E>(self) -> Result<Self, E> {
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serialize;
    use serde_json::json;
    use std::{
        env,
        fs::{self, OpenOptions},
        os::unix::fs::OpenOptionsExt,
    };

    const PRIVATE: &str = "/checkout/private-test-marker";
    fn native() -> String {
        json!({"turn_id":"fixture", "workspaces":{PRIVATE:{
            "associated_remote_urls":{"origin":"https://remote.invalid/private-test-marker"},
            "latest_git_commit_hash":"b".repeat(40), "has_changes":true
        }}})
        .to_string()
    }
    fn body(turn: &str) -> String {
        format!(
            r#"{{"client_metadata":{{"{TURN}":{}}}, "unrelated": [1.7000e+3, "keep  spacing"]}}"#,
            serde_json::to_string(turn).unwrap()
        )
    }
    fn mirror(turn: &str) -> Vec<HttpHeader> {
        vec![HttpHeader {
            name: TURN.into(),
            value: turn.into(),
        }]
    }
    fn capture(b: &str, h: Vec<HttpHeader>) -> Result<Capture, ()> {
        Capture::new(b.as_bytes(), h, true)
    }

    #[test]
    fn exact_body_and_mirror_projection_preserves_every_unrelated_request_byte() {
        let turn = native();
        let expected = r#"{"turn_id":"fixture"}"#;
        let p = capture(&body(&turn), mirror(&turn)).expect("known projection");
        assert_eq!(p.body.as_ref(), body(expected).as_bytes());
        assert_eq!(p.headers[0].value, expected);
    }
    #[test]
    fn no_workspace_is_byte_identical_and_non_inference_never_projects() {
        let no_ws = r#"{"turn_id":  "fixture"}"#;
        let b = body(no_ws);
        let c = capture(&b, mirror(no_ws)).unwrap();
        assert_eq!(c.body.as_ref(), b.as_bytes());
        assert_eq!(c.headers[0].value, no_ws);
        let turn = native();
        let b = body(&turn);
        let c = Capture::new(b.as_bytes(), mirror(&turn), false).unwrap();
        assert_eq!(c.body.as_ref(), b.as_bytes());
        assert_eq!(c.headers[0].value, turn);
        assert_eq!(
            capture(r#"{"input":"plain"}"#, vec![])
                .unwrap()
                .body
                .as_ref(),
            br#"{"input":"plain"}"#
        );
    }
    #[test]
    fn ambiguous_partial_malformed_oversize_and_new_workspace_shapes_fail_closed() {
        let t = native();
        let b = body(&t);
        assert!(capture(&b, vec![]).is_err(), "body-only leak");
        assert!(capture("{}", mirror(&t)).is_err(), "mirror-only leak");
        assert!(capture(&b, mirror("{}")).is_err(), "unequal mirrors");
        let mut twice = mirror(&t);
        twice.extend(mirror(&t));
        assert!(capture(&b, twice).is_err(), "duplicate header");
        let duplicate = b.replacen('{', r#"{"client_metadat\u0061":{}, "#, 1);
        assert!(
            capture(&duplicate, mirror(&t)).is_err(),
            "duplicate outer key with escape"
        );
        for malformed in [
            t.replacen('{', r#"{"turn_id":"duplicate","#, 1),
            t.replace("has_changes", "new_workspace_shape"),
            t.replace(PRIVATE, "not-an-absolute-root"),
            t.replace(&"b".repeat(40), "not-a-commit"),
            t.replace("true", "null"),
            t.replace("fixture", &"x".repeat(MAX_TURN_BYTES)),
        ] {
            assert!(capture(&body(&malformed), mirror(&malformed)).is_err());
        }
        let too_big = " ".repeat(crate::origin::BODY_LIMIT) + b.as_str();
        assert!(capture(&too_big, mirror(&t)).is_err());
    }

    /// Portable synthetic native -> exact production projection -> supplier peer contract test.
    /// No values go to stdout or panics. This exists only in the Rust test binary, not the gateway.
    #[test]
    #[ignore = "invoked with synthetic private input by the native and signed supplier peers"]
    fn portable_workspace_projection_peer() {
        #[derive(Deserialize, Serialize)]
        struct Peer {
            body: String,
            headers: Vec<(String, String)>,
        }
        let input = fs::read(
            env::var_os("STRANDS_WORKSPACE_PROJECTION_INPUT").expect("synthetic input path"),
        )
        .expect("read synthetic input");
        let peer: Peer = serde_json::from_slice(&input)
            .map_err(|_| ())
            .expect("synthetic JSON input");
        let headers = peer
            .headers
            .into_iter()
            .map(|(name, value)| HttpHeader { name, value })
            .collect();
        let captured = Capture::new(peer.body.as_bytes(), headers, true)
            .expect("exact product projection refused");
        let output = Peer {
            body: std::str::from_utf8(&captured.body)
                .map_err(|_| ())
                .expect("projected JSON")
                .into(),
            headers: captured
                .headers
                .into_iter()
                .map(|h| (h.name, h.value))
                .collect(),
        };
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(
                env::var_os("STRANDS_WORKSPACE_PROJECTION_OUTPUT")
                    .expect("private new output path"),
            )
            .expect("new private output file");
        serde_json::to_writer(file, &output).expect("write synthetic result");
    }
}
