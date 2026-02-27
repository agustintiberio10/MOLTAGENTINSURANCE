/**
 * useWallet — React hook for browser wallet connection (MetaMask/Rabby).
 *
 * Usage:
 *   const { address, signer, connected, chainId, connect, switchToBase } = useWallet();
 *
 * Architecture:
 *   window.ethereum (injected provider) → ethers.BrowserProvider → signer
 *   Handles chain switching to Base (8453) automatically.
 */

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { CHAIN_ID, CHAIN_NAME, RPC_URL } from "../lib/contracts";

export function useWallet() {
  const [address, setAddress] = useState(null);
  const [signer, setSigner] = useState(null);
  const [connected, setConnected] = useState(false);
  const [chainId, setChainId] = useState(null);

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      throw new Error("No wallet detected. Install MetaMask or Rabby.");
    }

    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    const walletSigner = await provider.getSigner();
    const walletAddress = await walletSigner.getAddress();
    const network = await provider.getNetwork();

    setAddress(walletAddress);
    setSigner(walletSigner);
    setConnected(true);
    setChainId(Number(network.chainId));
  }, []);

  const switchToBase = useCallback(async () => {
    if (!window.ethereum) return;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }],
      });
      setChainId(CHAIN_ID);
    } catch (switchError) {
      // Chain not added — add it
      if (switchError.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: `0x${CHAIN_ID.toString(16)}`,
              chainName: CHAIN_NAME,
              rpcUrls: [RPC_URL],
              nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
              blockExplorerUrls: ["https://basescan.org"],
            },
          ],
        });
        setChainId(CHAIN_ID);
      }
    }
  }, []);

  // Listen for account/chain changes
  useEffect(() => {
    if (!window.ethereum) return;

    const handleAccountsChanged = (accounts) => {
      if (accounts.length === 0) {
        setAddress(null);
        setSigner(null);
        setConnected(false);
      } else {
        setAddress(accounts[0]);
      }
    };

    const handleChainChanged = (newChainId) => {
      setChainId(parseInt(newChainId, 16));
    };

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);

    return () => {
      window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
      window.ethereum.removeListener("chainChanged", handleChainChanged);
    };
  }, []);

  return {
    address,
    signer,
    connected,
    chainId,
    isBase: chainId === CHAIN_ID,
    connect,
    switchToBase,
  };
}
