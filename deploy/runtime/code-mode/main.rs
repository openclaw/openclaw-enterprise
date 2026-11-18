mod native_cli {
    include!("../main.rs");

    pub(super) fn run() -> anyhow::Result<()> {
        main()
    }
}

fn main() -> anyhow::Result<()> {
    // Select the interpreter before the upstream CLI creates its first V8 isolate.
    codex_code_mode_runtime::initialize_v8(codex_code_mode_runtime::V8JitMode::Disabled)
        .map_err(anyhow::Error::msg)?;
    native_cli::run()
}
