# nightfrost production deployment

This deploys the fresh Fedora host at `155.138.255.120` as `nightfrost`:

- three `nightfrost` systemd services, connecting directly to the public
  Midnight WebSocket RPC endpoints;
- local APIs on `3101`, `3102`, and `3103`;
- Nginx vhosts for `preview.nightfrost.dev`, `mainnet.nightfrost.dev`,
  `preprod.nightfrost.dev`, the static explorer at `explorer.nightfrost.dev`,
  the landing page at `nightfrost.dev`, and the API reference at
  `docs.nightfrost.dev`.

The playbook does not compile remotely. It copies the local release build to
the production host. `ops/build-linux.sh` must be run on a native Linux x86_64
builder because the release build includes `aws-lc-sys` x86 assembly, which
does not compile reliably through Apple Silicon Docker emulation. It does not
install or run a Midnight node.

The explorer is a static Vite build served directly by Nginx; it does not need
its own systemd service. Build it locally with `ops/build-explorer.sh` before
deploying.

The landing page (`ops/landing/`) and API reference (`ops/docs/`) are
hand-authored static files, not build artifacts, so they're copied to the
host as-is, no build step needed. The API reference is Redoc rendering
`ops/docs/openapi.yaml`, loaded from a CDN at runtime.

## First deployment

From the repository root on a native Linux x86_64 builder:

```sh
ops/build-linux.sh
ops/build-explorer.sh
cp ops/inventory/production/group_vars/vault.yml.example \
  ops/inventory/production/group_vars/vault.yml
$EDITOR ops/inventory/production/group_vars/vault.yml
cd ops
ansible-vault encrypt inventory/production/group_vars/vault.yml
./deploy.sh
```

From Apple Silicon, build on the production host or another native x86_64
Linux machine, then copy `target/release/nightfrost` into this checkout.
Verify it reports `ELF 64-bit ... x86-64` with `file` before deploying.

The cursor secret must be retained across redeployments so existing pagination
cursors remain valid. Only the cursor secret is required. No Blockfrost
credentials are needed:
Nightfrost connects directly to the public RPC endpoints listed in the
production inventory.

The current Nginx configuration is HTTP-only. Point DNS at the production IP,
allow TCP/80 (and TCP/443 when TLS is added) in the provider firewall, then add
certificate termination as a follow-up deployment.

## Checks

Run a dry run after the Vault file and Linux binary are present:

```sh
cd ops
ansible-playbook playbooks/site.yml --ask-vault-pass --check --diff
```

Useful remote checks after deployment:

```sh
hostnamectl
systemctl --type=service --state=running | grep -E 'nightfrost|nginx'
curl -sS http://127.0.0.1:3101/api/v0/sync-status
curl -sS -H 'Host: preview.nightfrost.dev' http://127.0.0.1/api/v0/sync-status
```
