//! Process-wide counters and gauges behind GET /metrics.
//!
//! Plain atomics and one mutex-guarded map, no metrics library: every value
//! is written on a hot path by the chain pipeline, the node client, or the
//! HTTP layer, and read once per scrape by `nightfrost_api::metrics`, which
//! renders the Prometheus text format. Counters are process-local and reset
//! on restart; `rate()` and `increase()` absorb that.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Default)]
pub struct Counter(AtomicU64);

impl Counter {
    pub const fn new() -> Self {
        Self(AtomicU64::new(0))
    }
    pub fn inc(&self) {
        self.0.fetch_add(1, Relaxed);
    }
    pub fn add(&self, n: u64) {
        self.0.fetch_add(n, Relaxed);
    }
    pub fn get(&self) -> u64 {
        self.0.load(Relaxed)
    }
}

/// A u64 gauge; timestamps and byte counts only need integers.
#[derive(Default)]
pub struct Gauge(AtomicU64);

impl Gauge {
    pub const fn new() -> Self {
        Self(AtomicU64::new(0))
    }
    pub fn set(&self, v: u64) {
        self.0.store(v, Relaxed);
    }
    pub fn get(&self) -> u64 {
        self.0.load(Relaxed)
    }
}

pub fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---- chain pipeline ---------------------------------------------------------

/// Blocks fully indexed since process start.
pub static BLOCKS_INDEXED: Counter = Counter::new();
/// Wall time spent per pipeline stage, nanoseconds, cumulative. Same stages
/// as the "pipeline stage times" log line; `rate()` over them gives the
/// share of each stage.
pub static STAGE_FETCH_NANOS: Counter = Counter::new();
pub static STAGE_REPLAY_NANOS: Counter = Counter::new();
pub static STAGE_ROOTS_NANOS: Counter = Counter::new();
pub static STAGE_PERSIST_NANOS: Counter = Counter::new();
pub static STAGE_WRITE_NANOS: Counter = Counter::new();
pub static STAGE_GC_NANOS: Counter = Counter::new();
/// Wall-clock time the last block finished indexing.
pub static LAST_BLOCK_INDEXED_UNIX_SECS: Gauge = Gauge::new();
/// The last indexed block's own timestamp (chain time). `time()` minus this
/// is the indexer's lag in seconds, independent of the node height gauge.
pub static LAST_BLOCK_CHAIN_UNIX_SECS: Gauge = Gauge::new();
/// Times the block stream delivered a block whose parent was not the last
/// one seen and the pipeline re-subscribed.
pub static RESUBSCRIBES: Counter = Counter::new();

/// Adds a stage duration to its counter and hands it back, so call sites can
/// keep accumulating into their local `StageTimes` in one expression.
pub fn stage(counter: &Counter, elapsed: Duration) -> Duration {
    counter.add(elapsed.as_nanos() as u64);
    elapsed
}

// ---- node client ------------------------------------------------------------

/// "node disconnected, reconnecting" events from the RPC client.
pub static NODE_RECONNECTS: Counter = Counter::new();
/// Blocks dropped as duplicates, usually right after a reconnect.
pub static NODE_DUPLICATE_BLOCKS: Counter = Counter::new();
/// Errors the finalized-block stream passed through to the pipeline (which
/// exits on them); the "Request timeout" / "Invalid block hash" class.
pub static NODE_STREAM_ERRORS: Counter = Counter::new();

// ---- submissions --------------------------------------------------------------

/// POST /api/v0/tx/submit accepted by the node.
pub static TX_SUBMISSIONS_ACCEPTED: Counter = Counter::new();
/// POST /api/v0/tx/submit rejected: malformed body or node error.
pub static TX_SUBMISSIONS_REJECTED: Counter = Counter::new();

// ---- HTTP -------------------------------------------------------------------

/// Upper bounds of the request-latency histogram, seconds. Prometheus
/// convention: cumulative buckets plus an implicit +Inf.
pub const LATENCY_BUCKETS: [f64; 13] = [
    0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];

#[derive(Default, Clone)]
pub struct Histogram {
    pub buckets: [u64; LATENCY_BUCKETS.len()],
    pub count: u64,
    pub sum: f64,
}

impl Histogram {
    fn observe(&mut self, seconds: f64) {
        for (i, le) in LATENCY_BUCKETS.iter().enumerate() {
            if seconds <= *le {
                self.buckets[i] += 1;
            }
        }
        self.count += 1;
        self.sum += seconds;
    }
}

/// Per-route request accounting. The route is axum's matched path template
/// (`/api/v0/blocks/{id}`), so cardinality is the size of the route table.
#[derive(Default)]
pub struct HttpMetrics {
    /// (route, method, status) -> requests
    requests: Mutex<BTreeMap<(String, String, u16), u64>>,
    /// route -> latency histogram (all methods and statuses)
    latency: Mutex<BTreeMap<String, Histogram>>,
    inflight: AtomicU64,
}

pub static HTTP: HttpMetrics = HttpMetrics {
    requests: Mutex::new(BTreeMap::new()),
    latency: Mutex::new(BTreeMap::new()),
    inflight: AtomicU64::new(0),
};

/// Decrements the in-flight gauge when dropped, so a request whose future is
/// cancelled (client went away) is accounted for like a finished one.
pub struct InflightGuard<'a>(&'a HttpMetrics);

impl Drop for InflightGuard<'_> {
    fn drop(&mut self) {
        self.0.inflight.fetch_sub(1, Relaxed);
    }
}

/// The method label is bounded to the verbs the API serves; anything else a
/// client invents (axum answers 405) collapses to OTHER so it cannot grow
/// the label set or the map behind it.
pub fn normalize_method(method: &str) -> &'static str {
    match method {
        "GET" => "GET",
        "HEAD" => "HEAD",
        "POST" => "POST",
        "OPTIONS" => "OPTIONS",
        "PUT" => "PUT",
        "DELETE" => "DELETE",
        "PATCH" => "PATCH",
        _ => "OTHER",
    }
}

impl HttpMetrics {
    pub fn start(&self) -> InflightGuard<'_> {
        self.inflight.fetch_add(1, Relaxed);
        InflightGuard(self)
    }

    pub fn finish(&self, route: &str, method: &str, status: u16, elapsed: Duration) {
        let method = normalize_method(method);
        {
            let mut requests = self.requests.lock().expect("lock http requests");
            *requests
                .entry((route.to_owned(), method.to_owned(), status))
                .or_insert(0) += 1;
        }
        let mut latency = self.latency.lock().expect("lock http latency");
        latency
            .entry(route.to_owned())
            .or_default()
            .observe(elapsed.as_secs_f64());
    }

    pub fn inflight(&self) -> u64 {
        self.inflight.load(Relaxed)
    }

    pub fn requests_snapshot(&self) -> Vec<((String, String, u16), u64)> {
        let requests = self.requests.lock().expect("lock http requests");
        requests.iter().map(|(k, v)| (k.clone(), *v)).collect()
    }

    pub fn latency_snapshot(&self) -> Vec<(String, Histogram)> {
        let latency = self.latency.lock().expect("lock http latency");
        latency
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}
