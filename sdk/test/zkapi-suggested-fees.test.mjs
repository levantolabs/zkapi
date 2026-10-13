import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestedFees } from '../services/zkapiGas.mjs';

const provider = (baseFee, tip) => ({
    async request({ method }) {
        if (method === 'eth_getBlockByNumber') return baseFee == null ? {} : { baseFeePerGas: `0x${baseFee.toString(16)}` };
        if (method === 'eth_maxPriorityFeePerGas') {
            if (tip instanceof Error) throw tip;
            return `0x${tip.toString(16)}`;
        }
        throw new Error(`unexpected ${method}`);
    }
});
const gwei = n => BigInt(Math.round(n * 1e9));

test('suggests 2x base fee plus the network tip', async () => {
    const fees = await suggestedFees(provider(gwei(0.3), gwei(0.1)));
    assert.equal(BigInt(fees.maxPriorityFeePerGas), gwei(0.1));
    assert.equal(BigInt(fees.maxFeePerGas), gwei(0.7));
});

test('raises a near-zero tip to the 0.02 gwei floor and caps a spiky one at 2 gwei', async () => {
    assert.equal(BigInt((await suggestedFees(provider(gwei(0.3), 6_299n))).maxPriorityFeePerGas), gwei(0.02));
    assert.equal(BigInt((await suggestedFees(provider(gwei(0.3), gwei(9)))).maxPriorityFeePerGas), gwei(2));
});

test('keeps the floor when the wallet cannot suggest a tip', async () => {
    const fees = await suggestedFees(provider(gwei(1), new Error('unsupported')));
    assert.equal(BigInt(fees.maxPriorityFeePerGas), gwei(0.02));
    assert.equal(BigInt(fees.maxFeePerGas), gwei(2.02));
});

test('leaves fees to the wallet without an EIP-1559 base fee', async () => {
    assert.equal(await suggestedFees(provider(null, gwei(1))), null);
});
