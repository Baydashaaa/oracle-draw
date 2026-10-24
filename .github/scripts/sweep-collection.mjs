// Переводит LUNC со старого Circuit pool на новый. Можно запускать повторно.
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { stringToPath } from '@cosmjs/crypto';
import { SigningStargateClient, GasPrice } from '@cosmjs/stargate';

const RPC = 'https://terra-classic-rpc.publicnode.com:443';
const OLD = 'terra16m05j95p9qvq93cdtchjcpwgvny8f57vzdj06p';
const NEW = 'terra1gl53m8f096jvs6366yzee7p3qz6yxva35pjefz';
const DRY = process.env.DRY_RUN !== 'false';

const m = process.env.OLD_MNEMONIC;
if (!m) throw new Error('OLD_MNEMONIC is not set');
const wallet = await DirectSecp256k1HdWallet.fromMnemonic(m, { prefix: 'terra', hdPaths: [stringToPath("m/44'/330'/0'/0/0")] });
const [{ address }] = await wallet.getAccounts();
console.log('signer', address);
if (address !== OLD) throw new Error('signer is not the old collection wallet - stop');

const client = await SigningStargateClient.connectWithSigner(RPC, wallet, { gasPrice: GasPrice.fromString('28.325uluna') });
const bal = BigInt((await client.getBalance(OLD, 'uluna')).amount);
const amount = bal * 98n / 100n - 20_000_000n;
console.log('balance', Number(bal) / 1e6, 'LUNC, to send', Number(amount) / 1e6);
if (DRY || amount <= 0n) { console.log('nothing sent'); process.exit(0); }
const r = await client.sendTokens(OLD, NEW, [{ denom: 'uluna', amount: amount.toString() }], 1.6);
console.log('send tx', r.transactionHash);
