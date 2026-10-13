#!/bin/sh
# Keep private seeds and provider credentials in the process environment.
set -eu

# Match the artifacts installed by docker/Dockerfile; allow an explicit override.
ZKAPI_PROOF_SETUP_DIR=${ZKAPI_PROOF_SETUP_DIR:-/srv/zkapi/protocol/setup/v2}

require() {
    for name in "$@"; do
        if ! value=$(printenv "$name") || [ -z "$value" ]; then
            echo "Missing required environment variable: $name" >&2
            exit 1
        fi
    done
}

require CHAIN_ID VAULT_ADDRESS DEPLOY_BLOCK CIRCUIT_ID
if [ "$CIRCUIT_ID" != zkapi-v2-note-bound-v1 ]; then
    echo "This image requires the zkapi-v2-note-bound-v1 circuit and a fresh vault" >&2
    exit 1
fi

case "${1:-}" in
    server)
        require ZKAPI_STATE_SEED ZKAPI_CLEAR_SEED REQUEST_CHARGE_CAP ZKAPI_NATIVE_BILLING_RPC_URL ZKAPI_NATIVE_PRICE_FEED_ADDRESS
        case "$ZKAPI_STATE_SEED:$ZKAPI_CLEAR_SEED" in
            0x1:*|*:0x2)
                echo "Refusing the development signing seeds" >&2
                exit 1
                ;;
        esac
        set -- zkapi --protocol-version 2 --chain-id "$CHAIN_ID" \
            --contract-address "$VAULT_ADDRESS" \
            --request-charge-cap "$REQUEST_CHARGE_CAP" \
            --proof-setup-dir "$ZKAPI_PROOF_SETUP_DIR" \
            serverd --listen 0.0.0.0:3000 \
            --indexer-url http://indexer:3001 \
            --native-billing-rpc-url "$ZKAPI_NATIVE_BILLING_RPC_URL" \
            --native-price-feed-address "$ZKAPI_NATIVE_PRICE_FEED_ADDRESS" \
            --native-price-feed-decimals "${ZKAPI_NATIVE_PRICE_FEED_DECIMALS:-8}" \
            --native-price-max-age-seconds "${ZKAPI_NATIVE_PRICE_MAX_AGE_SECONDS:-4500}" \
            --openrouter-lease-ttl-seconds "${LEASE_TTL_SECONDS:-300}" \
            --openrouter-settlement-grace-seconds "${SETTLEMENT_GRACE_SECONDS:-5}" \
            --db-path /data/server.db
        if [ -n "${OA_ORG_URL:-}" ]; then
            set -- "$@" --oa-org-url "$OA_ORG_URL"
        fi
        if [ -n "${OPENROUTER_API_BASE:-}" ]; then
            set -- "$@" --openrouter-api-base "$OPENROUTER_API_BASE"
        fi
        if [ -n "${OPENROUTER_INFERENCE_BASE:-}" ]; then
            set -- "$@" --openrouter-inference-base "$OPENROUTER_INFERENCE_BASE"
        fi
        exec "$@"
        ;;
    indexer)
        require RPC_URL
        exec zkapi-indexerd --listen 0.0.0.0:3001 --rpc-url "$RPC_URL" \
            --poll-interval-ms "${INDEXER_POLL_INTERVAL_MS:-1000}" \
            --contract-address "$VAULT_ADDRESS" --from-block "$DEPLOY_BLOCK" \
            --cursor-path /data/indexer.cursor
        ;;
    challenger)
        require ZKAPI_CHALLENGE_RPC_URL ZKAPI_CHALLENGE_SENDER
        exec zkapi-challenged --indexer-url http://indexer:3001 \
            --chain-id "$CHAIN_ID" --contract-address "$VAULT_ADDRESS" \
            --from-block "$DEPLOY_BLOCK" --confirmations "${CHALLENGE_CONFIRMATIONS:-2}" \
            --poll-interval-ms "${CHALLENGER_POLL_INTERVAL_MS:-1000}" \
            --db-path /data/server.db --checkpoint /data/challenges.json \
            --proof-setup-dir "$ZKAPI_PROOF_SETUP_DIR"
        ;;
    *)
        echo "Usage: zkapi-run server|indexer|challenger" >&2
        exit 2
        ;;
esac
