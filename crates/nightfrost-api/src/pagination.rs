use crate::error::ApiError;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const CURSOR_PREFIX: &str = "nf1.";
const CURSOR_VERSION: u8 = 1;
const QUERY_HASH_LEN: usize = 16;
const MAC_LEN: usize = 16;
const FIXED_PAYLOAD_LEN: usize = 1 + 8 + 32 + QUERY_HASH_LEN + 2;
const MAX_CURSOR_LEN: usize = 1_024;

type HmacSha256 = Hmac<Sha256>;

/// Cursor pagination: `?count=1..100&order=asc|desc&cursor=nf1...`.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Pagination {
    pub count: usize,
    pub order: Order,
    pub cursor: Option<String>,
    /// Parsed only to reject legacy offset pagination explicitly instead of
    /// silently serving page one to an old client.
    pub page: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Order {
    Asc,
    Desc,
}

impl Default for Pagination {
    fn default() -> Self {
        Self {
            count: 100,
            order: Order::Asc,
            cursor: None,
            page: None,
        }
    }
}

impl Pagination {
    pub fn validate(&self) -> Result<(), ApiError> {
        if !(1..=100).contains(&self.count) {
            return Err(ApiError::bad_request(
                "querystring count should be within range 1-100",
            ));
        }
        if self.page.is_some() {
            return Err(ApiError::bad_request(
                "querystring page is no longer supported; use next_cursor as cursor",
            ));
        }
        if self
            .cursor
            .as_ref()
            .is_some_and(|cursor| cursor.len() > MAX_CURSOR_LEN)
        {
            return Err(ApiError::bad_request("cursor is too long"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TipAnchor {
    pub height: u64,
    pub hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedCursor {
    pub anchor: TipAnchor,
    /// Endpoint-specific logical sort tuple, never a database row locator.
    pub position: Vec<u8>,
}

#[derive(Clone)]
pub struct CursorCodec {
    key: Vec<u8>,
}

impl CursorCodec {
    pub fn new(key: impl Into<Vec<u8>>) -> Self {
        Self { key: key.into() }
    }

    pub fn encode(&self, scope: &[u8], anchor: &TipAnchor, position: &[u8]) -> String {
        let position_len = u16::try_from(position.len()).expect("cursor position <= u16::MAX");
        let mut payload = Vec::with_capacity(FIXED_PAYLOAD_LEN + position.len() + MAC_LEN);
        payload.push(CURSOR_VERSION);
        payload.extend_from_slice(&anchor.height.to_be_bytes());
        payload.extend_from_slice(&anchor.hash);
        payload.extend_from_slice(&query_hash(scope));
        payload.extend_from_slice(&position_len.to_be_bytes());
        payload.extend_from_slice(position);

        let mac = self.mac(&payload);
        payload.extend_from_slice(&mac[..MAC_LEN]);
        format!("{CURSOR_PREFIX}{}", URL_SAFE_NO_PAD.encode(payload))
    }

    pub fn decode(&self, token: &str, scope: &[u8]) -> Result<DecodedCursor, ApiError> {
        let encoded = token
            .strip_prefix(CURSOR_PREFIX)
            .ok_or_else(|| ApiError::bad_request("invalid cursor prefix"))?;
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| ApiError::bad_request("invalid cursor encoding"))?;
        if bytes.len() < FIXED_PAYLOAD_LEN + MAC_LEN {
            return Err(ApiError::bad_request("truncated cursor"));
        }

        let (payload, supplied_mac) = bytes.split_at(bytes.len() - MAC_LEN);
        let expected_mac = self.mac(payload);
        if !bool::from(supplied_mac.ct_eq(&expected_mac[..MAC_LEN])) {
            return Err(ApiError::bad_request("invalid cursor signature"));
        }
        if payload[0] != CURSOR_VERSION {
            return Err(ApiError::bad_request("unsupported cursor version"));
        }

        let height = u64::from_be_bytes(payload[1..9].try_into().expect("8-byte height"));
        let hash = payload[9..41].try_into().expect("32-byte hash");
        if payload[41..57] != query_hash(scope) {
            return Err(ApiError::bad_request(
                "cursor does not belong to this query",
            ));
        }
        let position_len =
            u16::from_be_bytes(payload[57..59].try_into().expect("2-byte length")) as usize;
        if payload.len() != FIXED_PAYLOAD_LEN + position_len {
            return Err(ApiError::bad_request("invalid cursor position length"));
        }

        Ok(DecodedCursor {
            anchor: TipAnchor { height, hash },
            position: payload[FIXED_PAYLOAD_LEN..].to_vec(),
        })
    }

    fn mac(&self, payload: &[u8]) -> [u8; 32] {
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC accepts any key length");
        mac.update(payload);
        mac.finalize().into_bytes().into()
    }
}

pub fn scope(parts: &[&[u8]], order: Order) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(match order {
        Order::Asc => 0,
        Order::Desc => 1,
    });
    for part in parts {
        out.extend_from_slice(&(part.len() as u32).to_be_bytes());
        out.extend_from_slice(part);
    }
    out
}

fn query_hash(scope: &[u8]) -> [u8; QUERY_HASH_LEN] {
    let digest = Sha256::digest(scope);
    digest[..QUERY_HASH_LEN].try_into().expect("16-byte prefix")
}

/// Smallest byte string lexicographically greater than every key with `prefix`.
/// `None` means the prefix is all `0xff` and therefore has no finite upper bound.
pub fn prefix_end(prefix: &[u8]) -> Option<Vec<u8>> {
    let mut end = prefix.to_vec();
    while let Some(last) = end.last_mut() {
        if *last != u8::MAX {
            *last += 1;
            return Some(end);
        }
        end.pop();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_round_trip_and_scope_binding() {
        let codec = CursorCodec::new(b"test secret");
        let anchor = TipAnchor {
            height: 42,
            hash: [7; 32],
        };
        let query = scope(&[b"address_txs", &[9; 32]], Order::Desc);
        let token = codec.encode(&query, &anchor, &123u64.to_be_bytes());
        let decoded = codec.decode(&token, &query).unwrap();
        assert_eq!(decoded.anchor, anchor);
        assert_eq!(decoded.position, 123u64.to_be_bytes());

        let other = scope(&[b"address_txs", &[8; 32]], Order::Desc);
        assert!(codec.decode(&token, &other).is_err());
    }

    #[test]
    fn cursor_rejects_tampering() {
        let codec = CursorCodec::new(b"test secret");
        let token = codec.encode(
            b"scope",
            &TipAnchor {
                height: 1,
                hash: [0; 32],
            },
            b"position",
        );
        let mut bytes = token.into_bytes();
        let last = bytes.len() - 1;
        bytes[last] = if bytes[last] == b'A' { b'B' } else { b'A' };
        assert!(
            codec
                .decode(std::str::from_utf8(&bytes).unwrap(), b"scope")
                .is_err()
        );
    }

    #[test]
    fn computes_prefix_upper_bound() {
        assert_eq!(prefix_end(&[0x12, 0x34]), Some(vec![0x12, 0x35]));
        assert_eq!(prefix_end(&[0x12, 0xff]), Some(vec![0x13]));
        assert_eq!(prefix_end(&[0xff]), None);
    }
}
