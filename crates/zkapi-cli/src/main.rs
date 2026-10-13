use clap::{Parser, Subcommand};
use std::path::PathBuf;
use zkapi_serverd::config::{OpenRouterLeaseConfig, OpenRouterLeaseSourceConfig, ServerConfig};
use zkapi_types::Felt252;

#[derive(Debug, Parser)]
#[command(name = "zkapi", about = "Native ETH zkAPI operator commands")]
struct Cli {
    #[arg(long, default_value_t = 2)]
    protocol_version: u16,
    #[arg(long, default_value_t = 1)]
    chain_id: u64,
    #[arg(long, default_value = "0x0")]
    contract_address: String,
    #[arg(long, default_value_t = 50_000)]
    request_charge_cap: u128,
    #[arg(
        long,
        env = "ZKAPI_PROOF_SETUP_DIR",
        default_value = "protocol/setup/v2"
    )]
    proof_setup_dir: String,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Clone, Subcommand)]
#[allow(clippy::large_enum_variant)]
enum Commands {
    /// Generate a fresh development setup in a new directory.
    Setup {
        #[arg(long)]
        output_dir: PathBuf,
    },
    /// Derive deployment-pinned public signing keys from server seeds.
    SigningKeys {
        #[arg(long, env = "ZKAPI_STATE_SEED")]
        state_seed: String,
        #[arg(long, env = "ZKAPI_CLEAR_SEED")]
        clear_seed: String,
    },
    #[command(name = "serverd", alias = "server")]
    Serverd {
        #[arg(long, default_value = "127.0.0.1:3000")]
        listen: String,
        /// OpenRouter management API base for direct lease provisioning.
        #[arg(long, default_value = "https://openrouter.ai/api")]
        openrouter_api_base: String,
        /// Inference base returned to clients with each lease, when it differs
        /// from `{openrouter_api_base}/v1` (an OpenRouter-compatible provider).
        #[arg(long)]
        openrouter_inference_base: Option<String>,
        /// OpenRouter Management API key used only to mint bounded runtime leases.
        #[arg(long)]
        openrouter_management_key: Option<String>,
        /// OA org base URL used to obtain station-issued, verifier-backed keys.
        #[arg(long)]
        oa_org_url: Option<String>,
        /// Validity of each prompt-private runtime key.
        #[arg(long, default_value_t = 300)]
        openrouter_lease_ttl_seconds: u64,
        /// Usage propagation delay after key expiry before settlement.
        #[arg(long, default_value_t = 5)]
        openrouter_settlement_grace_seconds: u64,
        #[arg(long, default_value_t = 2)]
        openrouter_settlement_poll_seconds: u64,
        /// Required native ETH oracle RPC for gwei billing.
        #[arg(long, env = "ZKAPI_NATIVE_BILLING_RPC_URL", required = true)]
        native_billing_rpc_url: Option<String>,
        #[arg(long, env = "ZKAPI_NATIVE_PRICE_FEED_ADDRESS", required = true)]
        native_price_feed_address: Option<String>,
        #[arg(long, default_value_t = 8)]
        native_price_feed_decimals: u8,
        #[arg(long, default_value_t = 3600)]
        native_price_max_age_seconds: u64,
        #[arg(long, default_value = "zkapi-server.db")]
        db_path: String,
        /// State-signing secret seed. Falls back to ZKAPI_STATE_SEED, then 0x1.
        #[arg(long)]
        state_seed: Option<String>,
        /// Clearance-signing secret seed. Falls back to ZKAPI_CLEAR_SEED, then 0x2.
        #[arg(long)]
        clear_seed: Option<String>,
        #[arg(long, default_value = "0x0")]
        initial_root: String,
        #[arg(long)]
        indexer_url: Option<String>,
        #[arg(long, default_value_t = 1_000)]
        root_poll_interval_ms: u64,
    },
    Indexer {
        #[arg(long, default_value = "127.0.0.1:3001")]
        listen: String,
        #[arg(long, default_value = "http://127.0.0.1:8545")]
        rpc_url: String,
        #[arg(long)]
        contract_address: String,
        #[arg(long, default_value_t = 0)]
        from_block: u64,
        #[arg(long, default_value_t = 1_000)]
        poll_interval_ms: u64,
        #[arg(long)]
        cursor_path: Option<String>,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(log_filter())
        .init();

    let cli = Cli::parse();

    match cli.command.clone() {
        Commands::Setup { output_dir } => {
            anyhow::ensure!(
                !output_dir.exists(),
                "refusing to overwrite an existing setup directory"
            );
            zkapi_proof::compact::setup(&output_dir)?;
            print_json(&serde_json::json!({
                "status": "ok",
                "proof_backend": "groth16_bn254",
                "output_dir": output_dir,
            }))?;
        }
        Commands::SigningKeys {
            state_seed,
            clear_seed,
        } => {
            let state = zkapi_proof::compact::CompactSigner::from_seed(&parse_felt(
                "state seed",
                &state_seed,
            )?);
            let clearance = zkapi_proof::compact::CompactSigner::from_seed(&parse_felt(
                "clearance seed",
                &clear_seed,
            )?);
            print_json(&serde_json::json!({
                "state_signing_key": state.public_key(),
                "clearance_signing_key": clearance.public_key(),
            }))?;
        }
        Commands::Serverd {
            listen,
            openrouter_api_base,
            openrouter_inference_base,
            openrouter_management_key,
            oa_org_url,
            openrouter_lease_ttl_seconds,
            openrouter_settlement_grace_seconds,
            openrouter_settlement_poll_seconds,
            native_billing_rpc_url,
            native_price_feed_address,
            native_price_feed_decimals,
            native_price_max_age_seconds,
            db_path,
            state_seed,
            clear_seed,
            initial_root,
            indexer_url,
            root_poll_interval_ms,
        } => {
            let state_seed = resolve_secret(state_seed, std::env::var("ZKAPI_STATE_SEED").ok())
                .unwrap_or_else(|| "0x1".to_string());
            let clear_seed = resolve_secret(clear_seed, std::env::var("ZKAPI_CLEAR_SEED").ok())
                .unwrap_or_else(|| "0x2".to_string());
            let openrouter_api_base_for_leases = openrouter_api_base.clone();
            let openrouter_management_key = resolve_secret(
                openrouter_management_key,
                std::env::var("ZKAPI_OPENROUTER_MANAGEMENT_KEY").ok(),
            );
            let oa_org_shared_secret =
                resolve_secret(None, std::env::var("ZKAPI_OA_ORG_SHARED_SECRET").ok());
            let lease_source = match (openrouter_management_key, oa_org_url, oa_org_shared_secret) {
                (Some(_), Some(_), _) | (Some(_), _, Some(_)) => {
                    anyhow::bail!(
                        "configure either direct OpenRouter management or OA org key issuance, not both"
                    )
                }
                (Some(management_key), None, None) => {
                    Some(OpenRouterLeaseSourceConfig::OpenRouter {
                        management_key,
                        api_base: openrouter_api_base_for_leases,
                        inference_base: openrouter_inference_base,
                    })
                }
                (None, Some(org_base_url), Some(shared_secret)) => {
                    Some(OpenRouterLeaseSourceConfig::OaOrg {
                        org_base_url,
                        shared_secret,
                    })
                }
                (None, Some(_), None) => {
                    anyhow::bail!("--oa-org-url requires an OA org shared secret")
                }
                (None, None, Some(_)) => {
                    anyhow::bail!("an OA org shared secret requires --oa-org-url")
                }
                (None, None, None) => anyhow::bail!(
                    "configure an OA org or OpenRouter management credential for native leases"
                ),
            };
            let openrouter_leases = lease_source.map(|source| OpenRouterLeaseConfig {
                source,
                ttl_seconds: openrouter_lease_ttl_seconds,
                settlement_grace_seconds: openrouter_settlement_grace_seconds,
                settlement_poll_seconds: openrouter_settlement_poll_seconds,
            });
            let native_billing = match (native_billing_rpc_url, native_price_feed_address) {
                (Some(rpc_url), Some(feed_address)) => {
                    Some(zkapi_serverd::native_billing::NativeBillingConfig {
                        rpc_url,
                        feed_address: feed_address.to_lowercase(),
                        decimals: native_price_feed_decimals,
                        max_age_seconds: native_price_max_age_seconds,
                    })
                }
                _ => anyhow::bail!("native ETH requires both oracle RPC and pinned feed address"),
            };
            let config = ServerConfig {
                protocol_version: cli.protocol_version,
                chain_id: cli.chain_id,
                testnet_password: None, // Loaded from the private server environment at startup.
                contract_address: parse_felt("contract address", &cli.contract_address)?,
                request_charge_cap: cli.request_charge_cap,
                listen_addr: listen,
                db_path,
                state_seed: parse_felt("state seed", &state_seed)?,
                clear_seed: parse_felt("clear seed", &clear_seed)?,
                initial_root: parse_felt("initial root", &initial_root)?,
                indexer_url,
                root_poll_interval_ms,
                openrouter_leases,
                native_billing,
                proof_setup_dir: cli.proof_setup_dir.clone(),
            };
            zkapi_serverd::routes::run_server(config).await?;
        }
        Commands::Indexer {
            listen,
            rpc_url,
            contract_address,
            from_block,
            poll_interval_ms,
            cursor_path,
        } => {
            let config = zkapi_indexerd::IndexerConfig {
                listen_addr: listen,
                rpc_url,
                contract_address,
                from_block,
                poll_interval_ms,
                cursor_path,
            };
            zkapi_indexerd::run_indexer(config).await?;
        }
    }
    Ok(())
}

fn log_filter() -> tracing_subscriber::EnvFilter {
    const DEFAULT: &str = "warn,zkapi=info,zkapi_serverd=info,zkapi_indexerd=info";
    let filter =
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| DEFAULT.into());

    // ark-r1cs-std instruments fine-grained field operations at INFO under the
    // `r1cs` target. Enabling those spans while proving debug-formats growing
    // constraint systems, turning a ~3-second proof into multi-gigabyte work.
    // Keep them disabled even when a caller uses a broad `RUST_LOG=info`.
    suppress_r1cs_info(filter)
}

fn suppress_r1cs_info(filter: tracing_subscriber::EnvFilter) -> tracing_subscriber::EnvFilter {
    filter.add_directive("r1cs=warn".parse().expect("valid r1cs log directive"))
}

fn parse_felt(label: &str, value: &str) -> anyhow::Result<Felt252> {
    Felt252::from_hex(value).map_err(|err| anyhow::anyhow!("invalid {label}: {err}"))
}

fn resolve_secret(cli_value: Option<String>, env_value: Option<String>) -> Option<String> {
    cli_value.or(env_value).filter(|value| !value.is_empty())
}

fn print_json<T: serde::Serialize>(value: &T) -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retired_wallet_and_auth_commands_are_rejected() {
        for command in [
            "client",
            "clientd",
            "keygen",
            "prepare-deposit",
            "confirm-deposit",
            "withdraw",
            "request",
        ] {
            assert!(Cli::try_parse_from(["zkapi", command]).is_err());
        }
        assert!(
            Cli::try_parse_from(["zkapi", "--auth-scheme", "blind-signature", "signing-keys"])
                .is_err()
        );
    }

    #[test]
    fn native_server_requires_oracle_and_feed() {
        assert!(Cli::try_parse_from(["zkapi", "serverd"]).is_err());
        assert!(Cli::try_parse_from([
            "zkapi",
            "serverd",
            "--native-billing-rpc-url",
            "https://rpc.example"
        ])
        .is_err());
        let cli = Cli::try_parse_from([
            "zkapi",
            "--chain-id",
            "11155111",
            "serverd",
            "--native-billing-rpc-url",
            "https://rpc.example",
            "--native-price-feed-address",
            "0x694AA1769357215DE4FAC081bf1f309aDC325306",
            "--oa-org-url",
            "https://org.example",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Commands::Serverd {
                native_billing_rpc_url: Some(_),
                native_price_feed_address: Some(_),
                ..
            }
        ));
    }

    #[test]
    fn indexer_and_signing_commands_remain_available() {
        assert!(Cli::try_parse_from(["zkapi", "indexer", "--contract-address", "0x1234"]).is_ok());
        assert!(Cli::try_parse_from([
            "zkapi",
            "signing-keys",
            "--state-seed",
            "0x1",
            "--clear-seed",
            "0x2"
        ])
        .is_ok());
        assert!(Cli::try_parse_from(["zkapi", "setup"]).is_err());
    }
}
