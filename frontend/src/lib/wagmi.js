/**
 * Wagmi + RainbowKit configuration for MutualPool dApp.
 *
 * Chain: Base Mainnet (8453)
 * Wallets: MetaMask, Rabby, Coinbase Wallet, WalletConnect
 */

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { base } from "wagmi/chains";

export const config = getDefaultConfig({
  appName: "MutualPool",
  // WalletConnect project ID — replace with your own from https://cloud.walletconnect.com
  projectId: process.env.VITE_WALLETCONNECT_PROJECT_ID || "PLACEHOLDER_PROJECT_ID",
  chains: [base],
  ssr: false,
});
