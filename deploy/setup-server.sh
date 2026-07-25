#!/usr/bin/env bash
# nightfrost setup for 64.226.124.57 — STRICTLY ADDITIVE: never touches the
# four existing midnight-node units (rpc 9944/9945/9946/9948) or their data.
# Adds two NEW archive node instances (reusing the installed binaries) plus
# two nightfrost indexer units. Idempotent. Run as root; source rsync'd to
# /opt/nightfrost/src first.
set -euo pipefail

echo "== 1. new archive node units (fresh ports + base paths, existing binaries)"
mkdir -p /opt/nightfrost/node-preview /opt/nightfrost/node-mainnet
chown -R midnight:midnight /opt/nightfrost/node-preview /opt/nightfrost/node-mainnet

cat > /etc/systemd/system/midnight-archive-preview.service <<'EOF'
[Unit]
Description=Midnight archive node (preview, nightfrost backend)
After=network-online.target
Wants=network-online.target

[Service]
User=midnight
WorkingDirectory=/home/midnight/midnight-node
Environment=CFG_PRESET=preview
Environment=BASE_PATH=/opt/nightfrost/node-preview
# BLOCKFROST_* (Cardano main-chain follower, required) appended below from the
# existing units — secrets stay on the host, out of this repo.
ExecStart=/usr/local/bin/midnight-node-preview --name mmahut-nightfrost-preview --no-private-ip --port 30340 --rpc-port 9950 --prometheus-port 9620 --state-pruning archive --blocks-pruning archive --bootnodes /dns/bootnode-1.preview.midnight.network/tcp/30333/ws/p2p/12D3KooWK66i7dtGVNSwDh9tTeqov1q6LSdWsRLJvTyzTCaywYgK --bootnodes /dns/bootnode-2.preview.midnight.network/tcp/30333/ws/p2p/12D3KooWHqFfXFwb7WW4jwR8pr4BEf562v5M6c8K3CXAJq4Wx6ym
Restart=on-failure
RestartSec=10
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/midnight-archive-mainnet.service <<'EOF'
[Unit]
Description=Midnight archive node (mainnet, nightfrost backend)
After=network-online.target
Wants=network-online.target

[Service]
User=midnight
WorkingDirectory=/home/midnight/midnight-node
Environment=BASE_PATH=/opt/nightfrost/node-mainnet
ExecStart=/usr/local/bin/midnight-node-mainnet --name mmahut-nightfrost-mainnet --no-private-ip --port 30341 --rpc-port 9951 --prometheus-port 9621 --state-pruning archive --blocks-pruning archive
Restart=on-failure
RestartSec=10
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

# The node's Cardano main-chain follower needs BLOCKFROST_ENDPOINT/PROJECT_ID;
# copy them (and mainnet's CFG_PRESET) from the existing units so the secrets
# never leave the host.
grep -h "Environment=BLOCKFROST_" /etc/systemd/system/midnight-node-fresh.service \
  | sed -i "/Environment=BASE_PATH=\/opt\/nightfrost\/node-preview/r /dev/stdin" \
      /etc/systemd/system/midnight-archive-preview.service
{ echo "Environment=CFG_PRESET=mainnet";
  grep -h "Environment=BLOCKFROST_" /etc/systemd/system/midnight-node-mainnet.service; } \
  | sed -i "/Environment=BASE_PATH=\/opt\/nightfrost\/node-mainnet/r /dev/stdin" \
      /etc/systemd/system/midnight-archive-mainnet.service

systemctl daemon-reload
systemctl enable --now midnight-archive-preview midnight-archive-mainnet

echo "== 2. rust toolchain + build deps"
command -v cc >/dev/null || apt-get install -y build-essential pkg-config libssl-dev clang
if [ ! -x /root/.cargo/bin/cargo ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none
fi
export PATH=/root/.cargo/bin:$PATH

echo "== 3. build nightfrost (source at /opt/nightfrost/src)"
cd /opt/nightfrost/src
cargo build --release
install -m755 target/release/nightfrost /usr/local/bin/nightfrost

echo "== 4. nightfrost units"
make_unit() {
  local name=$1 node_url=$2 network_id=$3 listen=$4
  cat > /etc/systemd/system/$name.service <<EOF
[Unit]
Description=nightfrost indexer ($network_id)
After=network-online.target

[Service]
Environment=RUST_LOG=info,midnight_ledger=warn
ExecStart=/usr/local/bin/nightfrost --node-url $node_url --network-id $network_id --data-dir /opt/nightfrost/data-$network_id --listen $listen
Restart=on-failure
RestartSec=60
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
}
make_unit nightfrost-preview ws://127.0.0.1:9950 preview 127.0.0.1:3101
# NOTE: mainnet network id is a first guess — genesis must index guard-green
# ("block indexed height=0" in journalctl -u nightfrost-mainnet); a wrong id
# fails immediately with a root mismatch, then adjust --network-id.
make_unit nightfrost-mainnet ws://127.0.0.1:9951 mainnet 127.0.0.1:3102
systemctl daemon-reload
systemctl enable --now nightfrost-preview nightfrost-mainnet

echo "== done; check:"
echo "  journalctl -fu midnight-archive-preview   # node sync"
echo "  journalctl -fu nightfrost-preview         # indexer (retries until node has archive blocks)"
echo "  curl -s localhost:3101/api/v0/sync-status"
