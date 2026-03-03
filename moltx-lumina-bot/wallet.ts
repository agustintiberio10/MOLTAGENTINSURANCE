// Wallet linking via EIP-712 challenge-response flow
// Signs typed data using viem's walletClient for Base L2 (chainId: 8453)

import { createWalletClient, http } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { apiCall, log } from './state';

const AGENT_ADDRESS = '0x2b4D825417f568231e809E31B9332ED146760337';
const CHAIN_ID = 8453; // Base L2

export interface ChallengeResponse {
  nonce: string;
  expires_at: string;
  typed_data: {
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    domain: Record<string, unknown>;
    message: Record<string, unknown>;
  };
}

function getAccount(): PrivateKeyAccount {
  const privateKey = process.env.WALLET_PRIVATE_KEY || process.env.AGENT_PRIVATE_KEY;
  if (!privateKey) throw new Error('WALLET_PRIVATE_KEY or AGENT_PRIVATE_KEY required in .env');

  const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  return privateKeyToAccount(key as `0x${string}`);
}

async function requestChallenge(): Promise<ChallengeResponse> {
  log('Requesting EIP-712 challenge for wallet linking...');
  const data = await apiCall('POST', '/agents/me/evm/challenge', {
    address: AGENT_ADDRESS,
    chainId: CHAIN_ID,
  });
  log(`Challenge received, nonce: ${data.nonce}, expires: ${data.expires_at}`);
  return data;
}

async function signChallenge(challenge: ChallengeResponse): Promise<string> {
  const account = getAccount();
  const client = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });
  const { typed_data } = challenge;

  log('Signing EIP-712 typed data...');
  const signature = await client.signTypedData({
    account,
    domain: typed_data.domain as any,
    types: typed_data.types as any,
    primaryType: typed_data.primaryType,
    message: typed_data.message as any,
  });

  log(`Signature generated: ${signature.slice(0, 20)}...`);
  return signature;
}

async function verifySignature(nonce: string, signature: string): Promise<boolean> {
  log('Verifying signature with MoltX API...');
  const data = await apiCall('POST', '/agents/me/evm/verify', {
    nonce,
    signature,
  });
  log(`Verification result: ${JSON.stringify(data)}`);
  return true;
}

export async function ensureWalletLinked(alreadyLinked: boolean): Promise<boolean> {
  if (alreadyLinked) {
    log(`Wallet already linked: ${AGENT_ADDRESS}`);
    return true;
  }

  try {
    const challenge = await requestChallenge();
    const signature = await signChallenge(challenge);
    await verifySignature(challenge.nonce, signature);
    log(`Wallet linked successfully: ${AGENT_ADDRESS} on chain ${CHAIN_ID}`);
    return true;
  } catch (err: any) {
    log(`Wallet linking failed: ${err.message}`);
    return false;
  }
}

export { AGENT_ADDRESS, CHAIN_ID };
