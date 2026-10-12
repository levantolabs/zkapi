#!/usr/bin/env node
// Build the Levanto zkAPI page for one network.
//
//   node site/levanto/build.mjs --network sepolia --manifest <public config.json> --out dist/site-sepolia
//
// --manifest is the deployment's public client manifest (what the gateway serves
// at /config.json). The page's browser-config.json pins the same values, so the
// SDK refuses a server that drifts from what this build trusts.
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBrowserSdkAssets } from '../../sdk/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) =>
    (value.startsWith('--') ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), []));
const network = args.network;
if (!['sepolia', 'mainnet'].includes(network) || !args.manifest || !args.out) {
    console.error('usage: build.mjs --network <sepolia|mainnet> --manifest <config.json> --out <dir>');
    process.exit(2);
}
const out = path.resolve(args.out);
const manifest = JSON.parse(await fs.readFile(args.manifest, 'utf8'));
if (manifest.network !== network) throw new Error(`manifest is for ${manifest.network}, not ${network}`);

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

// SDK worker, wasm and proving keys (hash-checked by the SDK build).
await buildBrowserSdkAssets({ outDir: path.join(out, 'zkapi'), publicPath: '/zkapi/', network, build });

const browserConfig = {
    deployment_manifest_url: manifest.config_url,
    allowed_deployment_manifest_urls: [manifest.config_url],
    trusted_deployment: {
        deployment_id: manifest.deployment_id,
        chain_id: manifest.chain_id,
        contract_address: manifest.contract_address,
        billing_token_address: null,
        protocol_server_url: manifest.protocol_server_url,
        indexer_url: manifest.indexer_url,
        request_charge_cap: manifest.request_charge_cap,
        state_signing_key: manifest.state_signing_key,
        clearance_signing_key: manifest.clearance_signing_key,
        rpc_url: manifest.rpc_url,
        billing_asset: manifest.billing_asset,
        billing_unit: manifest.billing_unit,
        native_asset_wei_per_unit: manifest.native_asset_wei_per_unit,
        native_price_feed_address: manifest.native_price_feed_address,
        native_price_feed_decimals: manifest.native_price_feed_decimals,
        native_price_max_age_seconds: manifest.native_price_max_age_seconds,
        request_proving_key_sha256: manifest.proof_setup.request_proving_key_sha256,
        withdrawal_proving_key_sha256: manifest.proof_setup.withdrawal_proving_key_sha256,
        circuit_id: manifest.proof_setup.circuit_id,
        verifier_url: manifest.privacy_mode.verifier_url,
        openrouter_inference_base: manifest.privacy_mode.openrouter_inference_base
    },
    proving_keys_base_url: './proofs/',
    credits_per_usd: null,
    billing_token_symbol: 'ETH',
    billing_token_decimals: 9,
    // Leases come from Levanto billing, not an OA org.
    require_oa_key_source: false
};
await fs.writeFile(path.join(out, 'zkapi', 'browser-config.json'), `${JSON.stringify(browserConfig, null, 2)}\n`);

await build({
    entryPoints: [path.join(HERE, 'app.js')],
    outfile: path.join(out, 'app.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: false,
    legalComments: 'none'
});

const html = (await fs.readFile(path.join(HERE, 'index.html'), 'utf8')).replace('__NETWORK__', network);
await fs.writeFile(path.join(out, 'index.html'), html);
await fs.copyFile(path.join(HERE, 'style.css'), path.join(out, 'style.css'));
await fs.cp(path.join(HERE, 'img'), path.join(out, 'img'), { recursive: true });
await fs.cp(path.join(HERE, 'fonts'), path.join(out, 'fonts'), { recursive: true });
console.log(`built ${network} site in ${out}`);
