use anyhow::{Context, ensure};
use nightfrost_core::store::Store;
use std::path::Path;
use std::process::Command;

/// Where the nightly snapshots are published; each network directory holds
/// the archives and a plaintext `latest` pointer naming the newest one.
pub const DEFAULT_SNAPSHOT_URL: &str = "https://nightfrost.dev/snapshots";

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

/// Downloads the newest published snapshot for `network` and restores it
/// into a fresh `data_dir`. The `latest` pointer is fetched first so the
/// archive name is never guessed; the download lands next to the data dir
/// (same filesystem, so the final rename is cheap) and is removed once
/// extracted. Uses curl like `save`/`restore` use tar: resumable, retrying,
/// and already on every host this runs on.
pub fn restore_published(base_url: &str, network: &str, data_dir: &str) -> anyhow::Result<()> {
    ensure!(
        !network.is_empty()
            && network
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-'),
        "network id {network:?} cannot name a published snapshot",
    );
    let parent = fresh_data_dir(data_dir)?;
    let base_url = base_url.trim_end_matches('/');

    let pointer_url = format!("{base_url}/{network}/latest");
    let pointer = Command::new("curl")
        .args(["-fsSL", "--retry", "3", "--max-time", "60"])
        .arg(&pointer_url)
        .output()
        .context("run curl")?;
    ensure!(
        pointer.status.success(),
        "could not fetch {pointer_url} (curl exited with {}): {}",
        pointer.status,
        String::from_utf8_lossy(&pointer.stderr).trim(),
    );
    let name = std::str::from_utf8(&pointer.stdout)
        .context("latest pointer is not utf-8")?
        .trim()
        .to_string();
    let expected_prefix = format!("nightfrost-{network}-snap-");
    ensure!(
        name.starts_with(&expected_prefix)
            && name.ends_with(".tar.xz")
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.' || b == b'_'),
        "unexpected snapshot name {name:?} in {pointer_url}",
    );

    let archive_url = format!("{base_url}/{network}/{name}");
    let archive = parent.join(format!(".{name}.download"));
    println!("downloading {archive_url}");
    let status = Command::new("curl")
        .args(["-fL", "--retry", "5", "--retry-all-errors", "-C", "-", "-o"])
        .arg(&archive)
        .arg(&archive_url)
        .status()
        .context("run curl")?;
    ensure!(
        status.success(),
        "download of {archive_url} failed (curl exited with {status}); rerun to resume",
    );

    let archive_str = archive
        .to_str()
        .context("download path is not utf-8")?
        .to_string();
    println!("extracting {name}");
    restore(&archive_str, data_dir)?;
    std::fs::remove_file(&archive)
        .with_context(|| format!("remove downloaded archive {}", archive.display()))?;
    Ok(())
}

/// Checks that `data_dir` does not exist yet and returns its parent
/// directory, created if needed.
fn fresh_data_dir(data_dir: &str) -> anyhow::Result<&Path> {
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
    Ok(parent)
}

/// Extracts a `save`-produced archive into a fresh `data_dir`, ready to
/// point a new instance at.
pub fn restore(input: &str, data_dir: &str) -> anyhow::Result<()> {
    let parent = fresh_data_dir(data_dir)?;
    let data_dir = Path::new(data_dir);

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
