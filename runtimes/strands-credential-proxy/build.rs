// Generate from the owning signed Credential Proxy wire contract, not from a private protocol copy.
fn main() {
    let proto = "../../apps/controller/src/drivers/egress-proxy/proto/supervisor_middleware.proto";
    println!("cargo:rerun-if-changed={proto}");
    tonic_prost_build::configure()
        .compile_protos(
            &[proto],
            &[std::path::Path::new(proto)
                .parent()
                .unwrap()
                .to_str()
                .unwrap()],
        )
        .expect("signed InstallationExchange proto");
}
