/**
 * usePoolActions — React hook for executing pool transactions via Router.
 *
 * Provides three action flows:
 *   1. fundPremiumWithUSDC — Insured pays premium (Pending → Open)
 *   2. joinPoolWithUSDC — Provider deposits collateral (Open → Active)
 *   3. joinPoolWithMPOOL — Provider deposits MPOOLV3 (auto-swap → USDC → join)
 *   4. withdraw — Claim funds after resolution
 *
 * All USDC/MPOOLV3 deposits go through the Router.
 * Withdraw/cancel/emergency go directly to the Vault.
 */

import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { CONTRACTS, VAULT_ABI, ROUTER_ABI, ERC20_ABI } from "../lib/contracts";

/**
 * @param {import('ethers').Signer} signer — connected wallet signer
 * @returns {object} Action functions and transaction state
 */
export function usePoolActions(signer) {
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState(null);
  const [error, setError] = useState(null);

  const resetState = () => {
    setLoading(false);
    setTxHash(null);
    setError(null);
  };

  // ── Helper: ensure USDC allowance for Router ──
  const ensureAllowance = useCallback(
    async (tokenAddress, spender, amountWei) => {
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
      const owner = await signer.getAddress();
      const currentAllowance = await token.allowance(owner, spender);

      if (currentAllowance < amountWei) {
        const approveTx = await token.approve(spender, amountWei);
        await approveTx.wait();
        return approveTx.hash;
      }
      return null; // Already sufficient
    },
    [signer]
  );

  // ═══════════════════════════════════════════════════
  // ACTION 1: Fund Premium with USDC (Insured)
  // ═══════════════════════════════════════════════════

  const fundPremiumWithUSDC = useCallback(
    async (poolId, usdcAmount) => {
      resetState();
      setLoading(true);

      try {
        const amountWei = ethers.parseUnits(usdcAmount.toString(), 6);

        // Step 1: Approve USDC for Router
        await ensureAllowance(CONTRACTS.USDC, CONTRACTS.ROUTER, amountWei);

        // Step 2: Call Router.fundPremiumWithUSDC
        const router = new ethers.Contract(CONTRACTS.ROUTER, ROUTER_ABI, signer);
        const tx = await router.fundPremiumWithUSDC(poolId, amountWei);
        setTxHash(tx.hash);

        const receipt = await tx.wait();
        setLoading(false);
        return { hash: tx.hash, receipt };
      } catch (err) {
        setError(err.reason || err.message);
        setLoading(false);
        throw err;
      }
    },
    [signer, ensureAllowance]
  );

  // ═══════════════════════════════════════════════════
  // ACTION 2: Join Pool with USDC (Provider)
  // ═══════════════════════════════════════════════════

  const joinPoolWithUSDC = useCallback(
    async (poolId, usdcAmount) => {
      resetState();
      setLoading(true);

      try {
        const amountWei = ethers.parseUnits(usdcAmount.toString(), 6);

        // Step 1: Approve USDC for Router
        await ensureAllowance(CONTRACTS.USDC, CONTRACTS.ROUTER, amountWei);

        // Step 2: Call Router.joinPoolWithUSDC
        const router = new ethers.Contract(CONTRACTS.ROUTER, ROUTER_ABI, signer);
        const tx = await router.joinPoolWithUSDC(poolId, amountWei);
        setTxHash(tx.hash);

        const receipt = await tx.wait();
        setLoading(false);
        return { hash: tx.hash, receipt };
      } catch (err) {
        setError(err.reason || err.message);
        setLoading(false);
        throw err;
      }
    },
    [signer, ensureAllowance]
  );

  // ═══════════════════════════════════════════════════
  // ACTION 3: Join Pool with MPOOLV3 (Provider, Swap)
  // ═══════════════════════════════════════════════════

  const joinPoolWithMPOOL = useCallback(
    async (poolId, mpoolAmount, minUsdcOut) => {
      resetState();
      setLoading(true);

      try {
        const mpoolWei = ethers.parseUnits(mpoolAmount.toString(), 18);
        const minOutWei = ethers.parseUnits(minUsdcOut.toString(), 6);

        // Step 1: Approve MPOOLV3 for Router
        await ensureAllowance(CONTRACTS.MPOOLV3_TOKEN, CONTRACTS.ROUTER, mpoolWei);

        // Step 2: Call Router.joinPoolWithMPOOL
        const router = new ethers.Contract(CONTRACTS.ROUTER, ROUTER_ABI, signer);
        const tx = await router.joinPoolWithMPOOL(poolId, mpoolWei, minOutWei);
        setTxHash(tx.hash);

        const receipt = await tx.wait();
        setLoading(false);
        return { hash: tx.hash, receipt };
      } catch (err) {
        setError(err.reason || err.message);
        setLoading(false);
        throw err;
      }
    },
    [signer, ensureAllowance]
  );

  // ═══════════════════════════════════════════════════
  // ACTION 4: Withdraw (Post-resolution)
  // ═══════════════════════════════════════════════════

  const withdraw = useCallback(
    async (poolId) => {
      resetState();
      setLoading(true);

      try {
        const vault = new ethers.Contract(CONTRACTS.MUTUAL_POOL_V3, VAULT_ABI, signer);
        const tx = await vault.withdraw(poolId);
        setTxHash(tx.hash);

        const receipt = await tx.wait();
        setLoading(false);
        return { hash: tx.hash, receipt };
      } catch (err) {
        setError(err.reason || err.message);
        setLoading(false);
        throw err;
      }
    },
    [signer]
  );

  // ═══════════════════════════════════════════════════
  // ACTION 5: Cancel and Refund
  // ═══════════════════════════════════════════════════

  const cancelAndRefund = useCallback(
    async (poolId) => {
      resetState();
      setLoading(true);

      try {
        const vault = new ethers.Contract(CONTRACTS.MUTUAL_POOL_V3, VAULT_ABI, signer);
        const tx = await vault.cancelAndRefund(poolId);
        setTxHash(tx.hash);

        const receipt = await tx.wait();
        setLoading(false);
        return { hash: tx.hash, receipt };
      } catch (err) {
        setError(err.reason || err.message);
        setLoading(false);
        throw err;
      }
    },
    [signer]
  );

  // ═══════════════════════════════════════════════════
  // QUOTE: MPOOLV3 → USDC
  // ═══════════════════════════════════════════════════

  const quoteMpoolToUsdc = useCallback(
    async (mpoolAmount) => {
      const router = new ethers.Contract(CONTRACTS.ROUTER, ROUTER_ABI, signer);
      const mpoolWei = ethers.parseUnits(mpoolAmount.toString(), 18);
      const usdcOut = await router.quoteMpoolToUsdc(mpoolWei);
      return ethers.formatUnits(usdcOut, 6);
    },
    [signer]
  );

  return {
    // Actions
    fundPremiumWithUSDC,
    joinPoolWithUSDC,
    joinPoolWithMPOOL,
    withdraw,
    cancelAndRefund,
    quoteMpoolToUsdc,

    // State
    loading,
    txHash,
    error,
    resetState,
  };
}
