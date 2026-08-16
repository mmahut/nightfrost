#!/usr/bin/env bash
# Local dev supervisor: restarts nightfrost immediately if it exits for any
# reason (e.g. the pipeline watchdog exiting after a stall). Not meant for
# production use, just so this dev instance self-heals like the real
# systemd-managed deployments do.
cd "$(dirname "${BASH_SOURCE[0]}")/.."
while true; do
  ./target/release/nightfrost --data-dir ./data --listen 127.0.0.1:3100
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] nightfrost exited with code $?, restarting in 2s" >&2
  sleep 2
done
