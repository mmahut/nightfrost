use anyhow::{Context, ensure};
use std::io::{Read, Write};

pub fn run(config_path: &str, force: bool) -> anyhow::Result<()> {
    ensure!(
        force || !std::path::Path::new(config_path).exists(),
        "{config_path} already exists; pass --force to overwrite"
    );

    crate::banner::print();
    println!("Let's set up your nightfrost config.\n");

    let network = prompt_choice("Network", &["preview", "preprod", "mainnet"], "preview")?;
    let default_node_url = format!("wss://rpc.{network}.midnight.network");
    let node_url = prompt("Node URL", &default_node_url)?;
    let data_dir = prompt("Data directory", &format!("./data-{network}"))?;
    let listen = prompt("Listen address", "127.0.0.1:3000")?;
    let cursor_secret = prompt("Cursor secret (blank = generate one)", "")?;
    let cursor_secret = if cursor_secret.is_empty() {
        generate_secret().context("generate cursor secret")?
    } else {
        cursor_secret
    };

    let contents = format!(
        "network_id = \"{network}\"\n\
         node_url = \"{node_url}\"\n\
         data_dir = \"{data_dir}\"\n\
         listen = \"{listen}\"\n\
         cursor_secret = \"{cursor_secret}\"\n"
    );
    std::fs::write(config_path, contents).with_context(|| format!("write {config_path}"))?;

    println!("\nwrote {config_path} — run `nightfrost` to start.");
    Ok(())
}

fn prompt(label: &str, default: &str) -> anyhow::Result<String> {
    if default.is_empty() {
        print!("{label}: ");
    } else {
        print!("{label} [{default}]: ");
    }
    std::io::stdout().flush().context("flush stdout")?;

    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .context("read stdin")?;
    let line = line.trim();
    Ok(if line.is_empty() {
        default.to_string()
    } else {
        line.to_string()
    })
}

fn prompt_choice(label: &str, choices: &[&str], default: &str) -> anyhow::Result<String> {
    loop {
        let answer = prompt(&format!("{label} ({})", choices.join("/")), default)?;
        if choices.contains(&answer.as_str()) {
            return Ok(answer);
        }
        println!("please choose one of: {}", choices.join(", "));
    }
}

fn generate_secret() -> anyhow::Result<String> {
    let mut buf = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .context("open /dev/urandom")?
        .read_exact(&mut buf)
        .context("read /dev/urandom")?;
    Ok(const_hex::encode(buf))
}
