// Vendored from midnight-indexer (chain-indexer/build.rs).
// Copyright (C) Midnight Foundation, Apache-2.0.
// Generates one subxt runtime module per node version listed in NODE_VERSIONS,
// from the committed .node/<version>/metadata.scale files.

use std::{
    env,
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::Path,
};

use anyhow::{Context, bail};
use itertools::Itertools;

const NODE_VERSIONS_PATH: &str = "../../NODE_VERSIONS";

fn main() -> anyhow::Result<()> {
    let out_dir = env::var("OUT_DIR").context("env var OUT_DIR must be set")?;
    let generated_runtime_path = Path::new(&out_dir).join("generated_runtime.rs");
    let mut generated_runtime_file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .create(true)
        .open(&generated_runtime_path)
        .with_context(|| {
            format!(
                "cannot open file for generated runtime code at {}",
                generated_runtime_path.display()
            )
        })?;

    let node_versions = read_node_versions()?;
    for node_version in node_versions {
        let metadata_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.node")
            .join(&node_version)
            .join("metadata.scale");
        let metadata_path = metadata_path
            .canonicalize()
            .with_context(|| format!("metadata file not found at {}", metadata_path.display()))?;

        // Module name: replace dots and hyphens with underscores
        let module_suffix = node_version
            .split_once('-')
            .map(|(l, _)| l)
            .unwrap_or(&node_version)
            .replace('.', "_");

        let generated_code = format!(
            r#"
                #[subxt::subxt(
                    runtime_metadata_path = "{}",
                    derive_for_type(
                        path = "sp_consensus_slots::Slot",
                        derive = "parity_scale_codec::Encode, parity_scale_codec::Decode",
                        recursive
                    )
                )]
                pub mod runtime_{module_suffix} {{}}
            "#,
            metadata_path.display()
        );

        writeln!(generated_runtime_file, "{}", generated_code).with_context(|| {
            format!("cannot write generated runtime code for node version {node_version}")
        })?;

        println!("cargo:rerun-if-changed={}", NODE_VERSIONS_PATH);
        println!("cargo:rerun-if-changed={}", metadata_path.display());
        println!("cargo:rerun-if-changed=../../.node");
    }

    Ok(())
}

fn read_node_versions() -> anyhow::Result<Vec<String>> {
    let node_versions_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(NODE_VERSIONS_PATH);
    let node_versions_path = node_versions_path.canonicalize().with_context(|| {
        format!(
            "node versions file not found at {}",
            node_versions_path.display()
        )
    })?;

    let node_versions_file = File::open(&node_versions_path).with_context(|| {
        format!(
            "cannot open node versions file at {}",
            node_versions_path.display()
        )
    })?;

    BufReader::new(node_versions_file)
        .lines()
        .filter_map_ok(|line| {
            let line = line.trim();
            (!line.is_empty()).then_some(line.to_string())
        })
        .map_ok(|v| validate_version(v.trim()))
        .flatten_ok()
        .collect::<Result<Vec<_>, _>>()
        .with_context(|| {
            format!(
                "cannot read lines of node versions file at {}",
                node_versions_path.display()
            )
        })
}

fn validate_version(version: &str) -> anyhow::Result<String> {
    const MAX_VERSION_LENGTH: usize = 64;
    if version.len() > MAX_VERSION_LENGTH {
        bail!(
            "node version must have less than {MAX_VERSION_LENGTH} characters, but had {}",
            version.len()
        )
    }

    const PERMITTED_SPECIAL_CHARS: [char; 3] = ['.', '-', '_'];
    let allowed_chars =
        |c: char| -> bool { c.is_ascii_alphanumeric() || PERMITTED_SPECIAL_CHARS.contains(&c) };
    if !version.chars().all(allowed_chars) {
        bail!(
            "invalid characters in node version {}",
            version
                .chars()
                .filter(|c| !allowed_chars(*c))
                .collect::<String>()
        );
    }

    if version.starts_with(PERMITTED_SPECIAL_CHARS) || version.ends_with(PERMITTED_SPECIAL_CHARS) {
        bail!(
            "node version must not start or end with {PERMITTED_SPECIAL_CHARS:?}, but got: '{}'",
            version
        );
    }

    Ok(version.to_string())
}
