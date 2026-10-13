// EIP-7825 rejects any Ethereum transaction whose gas limit exceeds 2^24,
// even when the block gas limit itself is higher. Keep the wallet-provided
// estimate comfortably padded, but never create a transaction the network
// cannot accept.
export const MAX_TRANSACTION_GAS_LIMIT = 1n << 24n;

const GAS_MARGIN_NUMERATOR = 12n;
const GAS_MARGIN_DENOMINATOR = 10n;
const GAS_FIXED_PADDING = 50_000n;

export function bufferedGasLimit(estimate) {
    const value = typeof estimate === 'bigint' ? estimate : BigInt(estimate);
    if (value <= 0n) throw new Error('The wallet returned an invalid gas estimate.');
    const buffered = value * GAS_MARGIN_NUMERATOR / GAS_MARGIN_DENOMINATOR + GAS_FIXED_PADDING;
    if (buffered > MAX_TRANSACTION_GAS_LIMIT) {
        const error = new Error('The simulated transaction exceeds Ethereum’s per-transaction gas limit. Nothing was submitted.');
        error.code = 'transaction_gas_limit_exceeded';
        throw error;
    }
    return `0x${buffered.toString(16)}`;
}

// Levanto: suggest EIP-1559 fees instead of leaving them to the wallet. Wallets
// default to a fixed ~1-2 gwei tip, which on a ~6M-gas vault transaction costs
// tens of dollars more than the network needs. maxFee = 2 x base + tip leaves
// room for a few full blocks; the user can still edit both in the wallet.
const MIN_PRIORITY_FEE_WEI = 20_000_000n; // 0.02 gwei
const MAX_PRIORITY_FEE_WEI = 2_000_000_000n; // 2 gwei

export async function suggestedFees(provider) {
    const block = await provider.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
    if (!block?.baseFeePerGas) return null;
    const base = BigInt(block.baseFeePerGas);
    let tip = MIN_PRIORITY_FEE_WEI;
    try {
        const suggested = BigInt(await provider.request({ method: 'eth_maxPriorityFeePerGas', params: [] }));
        tip = suggested < MIN_PRIORITY_FEE_WEI ? MIN_PRIORITY_FEE_WEI
            : suggested > MAX_PRIORITY_FEE_WEI ? MAX_PRIORITY_FEE_WEI : suggested;
    } catch {
        // Keep the floor.
    }
    return {
        maxPriorityFeePerGas: `0x${tip.toString(16)}`,
        maxFeePerGas: `0x${(base * 2n + tip).toString(16)}`
    };
}
