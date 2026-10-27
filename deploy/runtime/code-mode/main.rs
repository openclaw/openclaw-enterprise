use clap::Parser;
use codex_code_mode_runtime::V8JitMode;
use codex_code_mode_runtime::initialize_v8;

#[derive(Debug, Parser)]
struct Cli {
    /// Native code-mode transport endpoint.
    #[arg(long, value_name = "URL", default_value = codex_code_mode_host::DEFAULT_LISTEN_URL)]
    listen: String,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    // The sandbox forbids generating executable memory. Select the upstream
    // interpreter before run_main creates any V8 isolate.
    initialize_v8(V8JitMode::Disabled).map_err(anyhow::Error::msg)?;
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_max_level(tracing::Level::INFO)
        .init();
    codex_code_mode_host::run_main(&cli.listen).await
}
