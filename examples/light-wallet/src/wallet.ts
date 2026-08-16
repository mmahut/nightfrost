import { addressFromKey, signatureVerifyingKey } from '@midnight-ntwrk/ledger-v8';
import {
  generateMnemonicWords,
  HDWallet,
  joinMnemonicWords,
  Roles,
  validateMnemonic,
} from '@midnightntwrk/wallet-sdk-hd';
import { bech32m } from '@scure/base';
import { mnemonicToSeedSync } from '@scure/bip39';

export const NIGHT_DERIVATION_PATH = "m/44'/2400'/0'/0/0";

/** Generate a cryptographically random 24-word English BIP39 phrase. */
export function generateRecoveryPhrase(): string {
  return joinMnemonicWords(generateMnemonicWords());
}

/** Format a ledger user address in Midnight's network-specific bech32m form. */
export function formatNightAddress(addressHex: string, networkId: string): string {
  const prefix = networkId === 'mainnet' ? 'mn_addr' : `mn_addr_${networkId}`;
  return bech32m.encode(prefix, bech32m.toWords(hexToBytes(addressHex)), false);
}

/**
 * Derive the first external NIGHT address using the same BIP39 -> BIP32 flow
 * as Lace. Secret material is wiped where JavaScript permits before return.
 */
export function deriveNightAddress(words: string): string {
  const mnemonic = words.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!validateMnemonic(mnemonic)) {
    throw new Error('Enter a valid English BIP39 recovery phrase.');
  }

  const seed = mnemonicToSeedSync(mnemonic);
  const result = HDWallet.fromSeed(seed);
  if (result.type !== 'seedOk') {
    seed.fill(0);
    throw new Error('The recovery phrase could not initialize a Midnight HD wallet.');
  }

  const derived = result.hdWallet.selectAccount(0).selectRole(Roles.NightExternal).deriveKeyAt(0);
  result.hdWallet.clear();
  seed.fill(0);

  if (derived.type !== 'keyDerived') {
    throw new Error('The first external NIGHT key could not be derived.');
  }

  try {
    const secretHex = bytesToHex(derived.key);
    const verifyingKey = signatureVerifyingKey(secretHex);
    return addressFromKey(verifyingKey);
  } finally {
    derived.key.fill(0);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('Expected a 32-byte Midnight user address.');
  return Uint8Array.from(hex.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16));
}
