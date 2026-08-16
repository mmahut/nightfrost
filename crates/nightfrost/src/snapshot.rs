use anyhow::{Context, ensure};
use nightfrost_core::store::Store;
use std::path::Path;
use std::process::Command;

/// Flushes the store to disk, then archives the data directory as a
/// tar.xz. fjall does no locking of its own, so this must run with the
/// indexer stopped: a live snapshot could capture files mid-write.
pub fn save(data_dir: &str, output: &str) -> anyhow::Result<()> {
    {
        let store = Store::open(data_dir).context("open fjall keyspace")?;
        store
            .keyspace
            .persist(fjall::PersistMode::SyncAll)
            .context("sync keyspace to disk")?;
    }

    let data_dir = Path::new(data_dir)
        .canonicalize()
        .with_context(|| format!("resolve data dir {data_dir}"))?;
    let parent = data_dir.parent().context("data dir has no parent")?;
    let name = data_dir.file_name().context("data dir has no name")?;

    let status = Command::new("tar")
        .arg("-cJf")
        .arg(output)
        .arg("-C")
        .arg(parent)
        .arg(name)
        .status()
        .context("run tar")?;
    ensure!(status.success(), "tar exited with status {status}");
    Ok(())
}

/// Extracts a `save`-produced archive into a fresh `data_dir`, ready to
/// point a new instance at.
pub fn restore(input: &str, data_dir: &str) -> anyhow::Result<()> {
    let data_dir = Path::new(data_dir);
    ensure!(
        !data_dir.exists(),
        "data dir {} already exists; restore only into a fresh directory",
        data_dir.display(),
    );
    let parent = match data_dir.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;

    let listing = Command::new("tar")
        .arg("-tf")
        .arg(input)
        .output()
        .context("list tar contents")?;
    ensure!(
        listing.status.success(),
        "tar -tf exited with status {}",
        listing.status
    );
    let first_entry = std::str::from_utf8(&listing.stdout)
        .context("tar listing is not utf-8")?
        .lines()
        .next()
        .context("snapshot archive is empty")?;
    let top_name = first_entry
        .split('/')
        .next()
        .filter(|s| !s.is_empty())
        .with_context(|| format!("malformed tar entry {first_entry}"))?
        .to_string();

    let status = Command::new("tar")
        .arg("-xJf")
        .arg(input)
        .arg("-C")
        .arg(parent)
        .status()
        .context("run tar")?;
    ensure!(status.success(), "tar exited with status {status}");

    let extracted = parent.join(&top_name);
    if extracted != data_dir {
        std::fs::rename(&extracted, data_dir)
            .with_context(|| format!("move {} to {}", extracted.display(), data_dir.display()))?;
    }
    Ok(())
}
