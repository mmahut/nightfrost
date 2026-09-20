//! Prometheus text exposition at GET /metrics, plus the HTTP middleware that
//! feeds the request counters. Store gauges are read directly from fjall at
//! scrape time; everything else comes from `nightfrost_core::metrics`.

use crate::{error::ApiError, routes::ApiState, routes::internal};
use axum::{
    extract::{MatchedPath, Request, State},
    middleware::Next,
    response::Response,
};
use nightfrost_core::metrics as m;
use nightfrost_core::store::meta_keys;
use std::fmt::Write;
use std::sync::Arc;
use std::time::Instant;

/// Counts every request by matched route, method and status, and records
/// its latency. Applied over the whole app in main.rs so the submit router
/// is covered too. Unrouted requests (404s) are labelled "unmatched".
pub async fn track_http(request: Request, next: Next) -> Response {
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|p| p.as_str().to_owned())
        .unwrap_or_else(|| "unmatched".to_owned());
    let method = request.method().as_str().to_owned();
    let started = Instant::now();
    let inflight = m::HTTP.start();
    let response = next.run(request).await;
    drop(inflight);
    m::HTTP.finish(
        &route,
        &method,
        response.status().as_u16(),
        started.elapsed(),
    );
    response
}

pub async fn metrics(State(state): State<Arc<ApiState>>) -> Result<String, ApiError> {
    let indexed_height = state.store.last_indexed_height().map_err(internal)?;
    let node_height = *state.highest_block.read().expect("lock highest block");
    let caught_up =
        matches!((indexed_height, node_height), (Some(i), Some(n)) if n.saturating_sub(i) <= 10);
    let txs = state
        .store
        .next_id(meta_keys::NEXT_TX_ID)
        .map_err(internal)?;
    let actions = state
        .store
        .next_id(meta_keys::NEXT_ACTION_ID)
        .map_err(internal)?;
    let events = state
        .store
        .next_id(meta_keys::NEXT_EVENT_ID)
        .map_err(internal)?;

    let mut out = String::with_capacity(16 * 1024);

    let gauge = |out: &mut String, name: &str, help: &str, value: f64| {
        let _ = writeln!(
            out,
            "# HELP {name} {help}\n# TYPE {name} gauge\n{name} {value}"
        );
    };
    let counter = |out: &mut String, name: &str, help: &str, value: u64| {
        let _ = writeln!(
            out,
            "# HELP {name} {help}\n# TYPE {name} counter\n{name} {value}"
        );
    };

    // ---- sync state (unchanged names) ---------------------------------------
    gauge(
        &mut out,
        "nightfrost_indexed_height",
        "Highest block height indexed",
        indexed_height.map(|h| h as f64).unwrap_or(-1.0),
    );
    gauge(
        &mut out,
        "nightfrost_node_height",
        "Highest finalized block height seen on the node",
        node_height.map(|h| h as f64).unwrap_or(-1.0),
    );
    gauge(
        &mut out,
        "nightfrost_caught_up",
        "1 when the indexer is within 10 blocks of the node tip",
        caught_up as u8 as f64,
    );
    gauge(
        &mut out,
        "nightfrost_transactions_total",
        "Transactions indexed",
        txs as f64,
    );
    gauge(
        &mut out,
        "nightfrost_contract_actions_total",
        "Contract actions indexed",
        actions as f64,
    );
    gauge(
        &mut out,
        "nightfrost_ledger_events_total",
        "Ledger events indexed",
        events as f64,
    );

    // ---- pipeline ----------------------------------------------------------------
    counter(
        &mut out,
        "nightfrost_blocks_indexed_total",
        "Blocks indexed since process start",
        m::BLOCKS_INDEXED.get(),
    );
    gauge(
        &mut out,
        "nightfrost_last_block_indexed_timestamp_seconds",
        "Wall-clock time the last block finished indexing (unix seconds; 0 before the first)",
        m::LAST_BLOCK_INDEXED_UNIX_SECS.get() as f64,
    );
    gauge(
        &mut out,
        "nightfrost_last_block_timestamp_seconds",
        "Chain timestamp of the last indexed block (unix seconds); time() minus this is the indexing lag",
        m::LAST_BLOCK_CHAIN_UNIX_SECS.get() as f64,
    );
    let _ = writeln!(
        out,
        "# HELP nightfrost_pipeline_stage_seconds_total Wall time spent per indexing stage since process start\n# TYPE nightfrost_pipeline_stage_seconds_total counter"
    );
    for (stage, c) in [
        ("fetch", &m::STAGE_FETCH_NANOS),
        ("replay", &m::STAGE_REPLAY_NANOS),
        ("roots", &m::STAGE_ROOTS_NANOS),
        ("persist", &m::STAGE_PERSIST_NANOS),
        ("write", &m::STAGE_WRITE_NANOS),
        ("gc", &m::STAGE_GC_NANOS),
    ] {
        let _ = writeln!(
            out,
            "nightfrost_pipeline_stage_seconds_total{{stage=\"{stage}\"}} {}",
            c.get() as f64 / 1e9
        );
    }
    counter(
        &mut out,
        "nightfrost_pipeline_resubscribes_total",
        "Times the block stream broke parent linkage and the pipeline re-subscribed",
        m::RESUBSCRIBES.get(),
    );

    // ---- node client -------------------------------------------------------------
    counter(
        &mut out,
        "nightfrost_node_reconnects_total",
        "RPC client disconnect-and-reconnect events",
        m::NODE_RECONNECTS.get(),
    );
    counter(
        &mut out,
        "nightfrost_node_duplicate_blocks_total",
        "Blocks dropped as duplicates after a reconnect",
        m::NODE_DUPLICATE_BLOCKS.get(),
    );
    counter(
        &mut out,
        "nightfrost_node_stream_errors_total",
        "Errors the finalized-block stream passed to the pipeline (timeouts, invalid block hash)",
        m::NODE_STREAM_ERRORS.get(),
    );

    // ---- submissions ---------------------------------------------------------------
    let _ = writeln!(
        out,
        "# HELP nightfrost_tx_submissions_total Transactions received on POST /api/v0/tx/submit since process start, by outcome\n\
         # TYPE nightfrost_tx_submissions_total counter\n\
         nightfrost_tx_submissions_total{{result=\"accepted\"}} {}\n\
         nightfrost_tx_submissions_total{{result=\"rejected\"}} {}",
        m::TX_SUBMISSIONS_ACCEPTED.get(),
        m::TX_SUBMISSIONS_REJECTED.get(),
    );

    // ---- store ----------------------------------------------------------------------
    gauge(
        &mut out,
        "nightfrost_store_disk_bytes",
        "Disk space used by the fjall keyspace",
        state.store.keyspace.disk_space() as f64,
    );
    let _ = writeln!(
        out,
        "# HELP nightfrost_store_partition_bytes Disk space used per fjall partition\n# TYPE nightfrost_store_partition_bytes gauge"
    );
    for partition in state.store.partitions() {
        let _ = writeln!(
            out,
            "nightfrost_store_partition_bytes{{partition=\"{}\"}} {}",
            partition.name,
            partition.disk_space()
        );
    }
    let _ = writeln!(
        out,
        "# HELP nightfrost_store_partition_segments Disk segments per fjall partition; a climbing count with a flat size means compaction is behind\n# TYPE nightfrost_store_partition_segments gauge"
    );
    for partition in state.store.partitions() {
        let _ = writeln!(
            out,
            "nightfrost_store_partition_segments{{partition=\"{}\"}} {}",
            partition.name,
            partition.segment_count()
        );
    }
    gauge(
        &mut out,
        "nightfrost_store_journal_count",
        "Journal files retained by the keyspace; grows when flushing falls behind writes",
        state.store.journal_count() as f64,
    );
    gauge(
        &mut out,
        "nightfrost_store_write_buffer_bytes",
        "Bytes in fjall's in-memory write buffer awaiting flush",
        state.store.keyspace.write_buffer_size() as f64,
    );

    // ---- HTTP -------------------------------------------------------------------------
    gauge(
        &mut out,
        "nightfrost_http_inflight_requests",
        "Requests currently being handled",
        m::HTTP.inflight() as f64,
    );
    let _ = writeln!(
        out,
        "# HELP nightfrost_http_requests_total Requests handled, by matched route, method and status\n# TYPE nightfrost_http_requests_total counter"
    );
    for ((route, method, status), n) in m::HTTP.requests_snapshot() {
        let _ = writeln!(
            out,
            "nightfrost_http_requests_total{{route=\"{route}\",method=\"{method}\",status=\"{status}\"}} {n}"
        );
    }
    let _ = writeln!(
        out,
        "# HELP nightfrost_http_request_duration_seconds Request latency by matched route\n# TYPE nightfrost_http_request_duration_seconds histogram"
    );
    for (route, h) in m::HTTP.latency_snapshot() {
        for (i, le) in m::LATENCY_BUCKETS.iter().enumerate() {
            let _ = writeln!(
                out,
                "nightfrost_http_request_duration_seconds_bucket{{route=\"{route}\",le=\"{le}\"}} {}",
                h.buckets[i]
            );
        }
        let _ = writeln!(
            out,
            "nightfrost_http_request_duration_seconds_bucket{{route=\"{route}\",le=\"+Inf\"}} {}\n\
             nightfrost_http_request_duration_seconds_sum{{route=\"{route}\"}} {}\n\
             nightfrost_http_request_duration_seconds_count{{route=\"{route}\"}} {}",
            h.count, h.sum, h.count
        );
    }

    // ---- process -------------------------------------------------------------------------
    let _ = writeln!(
        out,
        "# HELP nightfrost_build_info Build information\n# TYPE nightfrost_build_info gauge\nnightfrost_build_info{{version=\"{}\"}} 1",
        env!("CARGO_PKG_VERSION")
    );
    if let Some(p) = process_stats() {
        gauge(
            &mut out,
            "process_resident_memory_bytes",
            "Resident set size",
            p.rss_bytes as f64,
        );
        counter(
            &mut out,
            "process_cpu_seconds_total",
            "User plus system CPU time consumed",
            p.cpu_seconds,
        );
        gauge(
            &mut out,
            "process_threads",
            "OS threads in the process",
            p.threads as f64,
        );
        gauge(
            &mut out,
            "process_open_fds",
            "Open file descriptors",
            p.open_fds as f64,
        );
    }

    Ok(out)
}

struct ProcessStats {
    rss_bytes: u64,
    cpu_seconds: u64,
    threads: u64,
    open_fds: u64,
}

/// Linux only, from procfs; `None` elsewhere. CLK_TCK is 100 on every Linux
/// target this runs on, so the tick conversion is a constant rather than a
/// libc dependency.
#[cfg(target_os = "linux")]
fn process_stats() -> Option<ProcessStats> {
    const CLK_TCK: u64 = 100;
    const PAGE_SIZE: u64 = 4096;
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    // The command name is in parentheses and may contain spaces; fields
    // start after the closing one.
    let after = &stat[stat.rfind(')')? + 2..];
    let fields: Vec<&str> = after.split_whitespace().collect();
    // Field numbering from proc(5), 1-based over the whole line; `after`
    // starts at field 3.
    let utime: u64 = fields.get(11)?.parse().ok()?;
    let stime: u64 = fields.get(12)?.parse().ok()?;
    let threads: u64 = fields.get(17)?.parse().ok()?;
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    let rss_pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
    let open_fds = std::fs::read_dir("/proc/self/fd").ok()?.count() as u64;
    Some(ProcessStats {
        rss_bytes: rss_pages * PAGE_SIZE,
        cpu_seconds: (utime + stime) / CLK_TCK,
        threads,
        open_fds,
    })
}

#[cfg(not(target_os = "linux"))]
fn process_stats() -> Option<ProcessStats> {
    None
}
