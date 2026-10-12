//! Server configuration.

use zkapi_types::Felt252;

/// Source used to provision prompt-private, short-lived OpenRouter keys.
#[derive(Clone)]
pub enum OpenRouterLeaseSourceConfig {
    /// Mint child keys directly with an OpenRouter management key.
    OpenRouter {
        management_key: String,
        /// OpenRouter API base without `/v1`.
        api_base: String,
        /// Public inference base handed to clients instead of `{api_base}/v1`,
        /// for an OpenRouter-compatible key provider whose management API and
        /// inference API live on different hosts.
        inference_base: Option<String>,
    },
    /// Ask an OA org to relay key creation to a verifier-enrolled station.
    OaOrg {
        org_base_url: String,
        /// Dedicated zkAPI service credential configured by the org.
        shared_secret: String,
    },
}

impl OpenRouterLeaseSourceConfig {
    pub fn label(&self) -> &'static str {
        match self {
            Self::OpenRouter { .. } => "openrouter",
            Self::OaOrg { .. } => "oa_org",
        }
    }
}

impl std::fmt::Debug for OpenRouterLeaseSourceConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OpenRouter {
                api_base,
                inference_base,
                ..
            } => formatter
                .debug_struct("OpenRouter")
                .field("management_key", &"[configured]")
                .field("api_base", api_base)
                .field("inference_base", inference_base)
                .finish(),
            Self::OaOrg { org_base_url, .. } => formatter
                .debug_struct("OaOrg")
                .field("org_base_url", org_base_url)
                .field("shared_secret", &"[configured]")
                .finish(),
        }
    }
}

/// Prompt-private lease configuration for native ETH billing.
#[derive(Debug, Clone)]
pub struct OpenRouterLeaseConfig {
    pub source: OpenRouterLeaseSourceConfig,
    /// Runtime-key validity window.
    pub ttl_seconds: u64,
    /// Delay after expiry (and after disabling directly managed keys) before
    /// reading aggregate usage, allowing in-flight calls and accounting to drain.
    pub settlement_grace_seconds: u64,
    /// Background settlement scan interval.
    pub settlement_poll_seconds: u64,
}

/// Configuration for the zkAPI server.
#[derive(Debug, Clone)]
pub struct ServerConfig {
    /// Protocol version (must be 2).
    pub protocol_version: u16,
    /// Chain ID this server is bound to.
    pub chain_id: u64,
    /// Optional shared Sepolia service gate; contains only a redacted digest.
    pub testnet_password: Option<crate::testnet_auth::TestnetPassword>,
    /// On-chain contract address.
    pub contract_address: Felt252,
    /// Minimum proof-bound lease budget, in whole gwei.
    pub request_charge_cap: u128,
    /// HTTP listen address (e.g. "0.0.0.0:3000").
    pub listen_addr: String,
    /// Path to the SQLite database file.
    pub db_path: String,
    /// Seed for the proof-friendly state-signing key.
    pub state_seed: Felt252,
    /// Seed for the proof-friendly clearance-signing key.
    pub clear_seed: Felt252,
    /// Initial Merkle root the server should accept until the indexer updates it.
    pub initial_root: Felt252,
    /// Optional base URL for an indexer that serves the latest tree root.
    pub indexer_url: Option<String>,
    /// Poll interval for indexer root refresh.
    pub root_poll_interval_ms: u64,
    /// Required prompt-private OpenRouter lease configuration.
    pub openrouter_leases: Option<OpenRouterLeaseConfig>,
    /// Required native ETH oracle configuration, checked before server startup.
    pub native_billing: Option<crate::native_billing::NativeBillingConfig>,
    /// Directory containing the v2 Groth16 proving/verifying key files.
    pub proof_setup_dir: String,
}

impl ServerConfig {
    pub fn validate_testnet_auth(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.testnet_password.is_none()
                || self.chain_id == crate::testnet_auth::SEPOLIA_CHAIN_ID,
            "ZKAPI_TESTNET_PASSWORD is only supported on Sepolia (chain ID 11155111)"
        );
        Ok(())
    }

    /// Reject incomplete native configurations before startup opens any state.
    pub fn validate_native_mode(&self) -> anyhow::Result<()> {
        self.validate_testnet_auth()?;
        anyhow::ensure!(
            self.native_billing.is_some(),
            "native ETH billing configuration is required"
        );
        anyhow::ensure!(
            self.openrouter_leases.is_some(),
            "native ETH requires prompt-private leases"
        );
        anyhow::ensure!(
            self.request_charge_cap > 0
                && self.request_charge_cap <= crate::native_billing::MAX_SAFE_UNITS,
            "native request cap must fit browser-safe gwei units"
        );
        Ok(())
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            protocol_version: 2,
            chain_id: 1,
            testnet_password: None,
            contract_address: Felt252::ZERO,
            request_charge_cap: 1_000_000,
            listen_addr: "0.0.0.0:3000".to_string(),
            db_path: "zkapi_server.db".to_string(),
            state_seed: Felt252::from_u64(1),
            clear_seed: Felt252::from_u64(2),
            initial_root: Felt252::ZERO,
            indexer_url: None,
            root_poll_interval_ms: 1_000,
            openrouter_leases: None,
            native_billing: None,
            proof_setup_dir: "protocol/setup/v2".to_string(),
        }
    }
}
