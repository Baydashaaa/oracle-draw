// One-off: переносит owner circuit-rewards и LUNC со старого buyback на новый.
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { stringToPath } from '@cosmjs/crypto';
import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate';
import { GasPrice } from '@cosmjs/stargate';

const RPC     = 'https://terra-classic-rpc.publicnode.com:443';
const OLD     = 'terra1x3axkacpes4d8q2svfeneqdtv8rvcvccrn66j5';
const NEW     = 'terra1e2cn6vayjjf85ehatmcchcrp2awlfyuu7pu5y2';
const REWARDS = 'terra18pau9q25ykswgey8ckcfxhdln27nk23qv6af0pjs2vye5r5crmcs7w9fr0';
const HD_PATH = "m/44'/330'/0'/0/0";
const DRY     = process.env.DRY_RUN !== 'false';

const mnemonic = process.env.CIRCUIT_BUYBACK_MNEMONIC;
if (!mnemonic) throw new Error('CIRCUIT_BUYBACK_MNEMONIC is not set');

const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: 'terra', hdPaths: [stringToPath(HD_PATH)] });
const [{ address }] = await wallet.getAccounts();
console.log('signer', address);
if (address !== OLD) throw new Error('signer is not the old buyback wallet - stop');

const client = await SigningCosmWasmClient.connectWithSigner(RPC, wallet, { gasPrice: GasPrice.fromString('28.325uluna') });

const before = await client.queryContractSmart(REWARDS, { config: {} });
const bal = BigInt((await client.getBalance(OLD, 'uluna')).amount);
console.log('owner before', before.owner);
console.log('balance', Number(bal) / 1e6, 'LUNC');
if (DRY) { console.log('dry run - nothing sent'); process.exit(0); }

if (before.owner === OLD) {
  const r = await client.execute(OLD, REWARDS, { update_owner: { new_owner: NEW } }, 1.6);
  console.log('update_owner tx', r.transactionHash);
}
const after = await client.queryContractSmart(REWARDS, { config: {} });
if (after.owner !== NEW) throw new Error('owner not changed: ' + after.owner);
console.log('owner after', after.owner);

const left = BigInt((await client.getBalance(OLD, 'uluna')).amount);
const amount = left * 98n / 100n - 20_000_000n;
if (amount > 0n) {
  const r = await client.sendTokens(OLD, NEW, [{ denom: 'uluna', amount: amount.toString() }], 1.6);
  console.log('send tx', r.transactionHash, Number(amount) / 1e6, 'LUNC');
}
