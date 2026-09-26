use nightfrost_api::{pagination::CursorCodec, router, routes::ApiState};
use nightfrost_core::{
    domain::{TransactionResult, TransactionVariant},
    store::{self, BlockRecord, Store, TxRecord, meta_keys, prefixed_u64_key},
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::SocketAddr,
    sync::Arc,
    time::Duration,
};

async fn get(address: SocketAddr, path: String, extra_headers: String) -> (String, Vec<u8>) {
    tokio::task::spawn_blocking(move || {
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n{extra_headers}\r\n"
        )
        .unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();
        let end = bytes
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .unwrap();
        let body = bytes.split_off(end + 4);
        (String::from_utf8(bytes).unwrap().to_lowercase(), body)
    })
    .await
    .unwrap()
}

fn insert_transaction(store: &Store, id: u64, record: &TxRecord, protocol_version: u32) {
    let mut batch = store.keyspace.batch();
    batch.insert(&store.txs, id.to_be_bytes(), store::encode(record));
    batch.insert(&store.txs_by_hash, prefixed_u64_key(&record.hash, id), []);
    for identifier in &record.identifiers {
        batch.insert(
            &store.txs_by_identifier,
            prefixed_u64_key(identifier, id),
            [],
        );
    }
    batch.insert(
        &store.blocks,
        record.block_height.to_be_bytes(),
        store::encode(&BlockRecord {
            hash: [id as u8; 32],
            parent_hash: [0; 32],
            timestamp: id * 6_000,
            protocol_version,
            author: (id > 0).then_some([7; 32]),
            first_tx_id: id,
            tx_count: 1,
            zswap_merkle_tree_root: vec![].into(),
            ledger_state_root: None,
        }),
    );
    batch.insert(
        &store.meta,
        meta_keys::LAST_HEIGHT,
        record.block_height.to_be_bytes(),
    );
    batch.commit().unwrap();
}

#[tokio::test]
async fn transaction_downloads_preserve_bytes_metadata_and_http_semantics() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(dir.path()).unwrap());
    let state = Arc::new(ApiState {
        store: store.clone(),
        network_id: "preview".into(),
        node_url: String::new(),
        highest_block: Default::default(),
        cursor_codec: CursorCodec::new("test"),
        wallet_scan_lock: Default::default(),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });

    // Opaque fixtures deliberately include non-UTF-8 and oversized bytes: the
    // download route must not decode, reserialize or apply request-body limits.
    for (id, protocol_version, variant, raw) in [
        (0, 1_000_000, TransactionVariant::Regular, b"abc".to_vec()),
        (
            1,
            1_000_000,
            TransactionVariant::System,
            vec![0, 255, 128, 13, 10],
        ),
        (
            2,
            2_001_000,
            TransactionVariant::Regular,
            vec![128; 3 * 1024 * 1024],
        ),
        (3, 2_001_000, TransactionVariant::System, vec![255, 0, 128]),
    ] {
        let hash = [id as u8 + 1; 32];
        let identifier = vec![id as u8; 33];
        let record = TxRecord {
            hash,
            block_height: id,
            index_in_block: 0,
            variant,
            result: TransactionResult::Success,
            paid_fees: 11,
            estimated_fees: 12,
            identifiers: vec![identifier.clone().into()],
            contract_action_ids: vec![],
            first_event_id: 0,
            event_count: 0,
            created_utxos: vec![],
            spent_utxos: vec![],
            raw: raw.clone().into(),
        };
        insert_transaction(&store, id, &record, protocol_version);
        let path = format!("/api/v0/txs/{}/raw", const_hex::encode(hash));
        let (headers, body) = get(address, path.clone(), String::new()).await;
        let etag = format!("\"{}\"", const_hex::encode(Sha256::digest(&raw)));
        assert!(headers.starts_with("http/1.1 200"));
        assert!(headers.contains("content-type: application/octet-stream\r\n"));
        assert!(headers.contains(&format!("content-length: {}\r\n", raw.len())));
        assert!(headers.contains(&format!("etag: {etag}\r\n")));
        assert!(headers.contains("cache-control: public, no-cache\r\n"));
        assert_eq!(body, raw);

        for condition in [etag.clone(), format!("\"other\", W/{etag}"), "*".into()] {
            let (headers, body) = get(
                address,
                path.clone(),
                format!("If-None-Match: {condition}\r\n"),
            )
            .await;
            assert!(headers.starts_with("http/1.1 304"));
            assert!(headers.contains(&format!("etag: {etag}\r\n")));
            assert!(body.is_empty());
        }
        let (headers, body) = get(address, path, "If-None-Match: \"different\"\r\n".into()).await;
        assert!(headers.starts_with("http/1.1 200"));
        assert_eq!(body, raw);

        // A repeated hash/identifier must still resolve its most recent inclusion.
        if id == 3 {
            insert_transaction(
                &store,
                4,
                &TxRecord {
                    block_height: 4,
                    ..record
                },
                protocol_version,
            );
        }
        for path in [
            format!("/api/v0/txs/{}", const_hex::encode(hash)),
            format!("/api/v0/txs/identifiers/{}", const_hex::encode(identifier)),
        ] {
            let (headers, body) = get(address, path, String::new()).await;
            assert!(headers.starts_with("http/1.1 200"));
            let json: Value = serde_json::from_slice(&body).unwrap();
            let tx = &json["results"];
            assert_eq!(tx["id"], if id == 3 { 4 } else { id });
            assert_eq!(tx["protocol_version"], protocol_version);
            assert_eq!(
                tx["block_author"],
                if id == 0 {
                    Value::Null
                } else {
                    const_hex::encode([7; 32]).into()
                }
            );
            assert!(tx.get("raw").is_none());
            assert_eq!(tx["paid_fees"], "11");
        }
    }

    for (hash, status) in [
        ("not-hex".into(), 400),
        ("aa".into(), 400),
        ("ff".repeat(32), 404),
    ] {
        let (headers, body) = get(
            address,
            format!("/api/v0/txs/{hash}/raw"),
            "If-None-Match: *\r\n".into(),
        )
        .await;
        assert!(headers.starts_with(&format!("http/1.1 {status}")));
        assert!(headers.contains("content-type: application/json\r\n"));
        let error: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(error["status_code"], status);
        assert!(error["message"].is_string());
    }
    server.abort();
}
