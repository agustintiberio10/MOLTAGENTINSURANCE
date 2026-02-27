/**
 * usePoolActions — React hook for executing pool transactions via Router.
 *
 * Granular state machine:
 *   idle → isApproving → isExecuting → isSuccess
 *                ↘          ↘
 *                 error       error
 *
 * Every ERC-20 action follows the approve→wait→execute→wait→success pattern:
 *   1. Check allowance — if insufficient, request USDC/MPOOLV3 approve signature
 *   2. Wait 1 block confirmation for approve tx
 *   3. Switch state to isExecuting — request Router method signature
 *   4. Wait 1 block confirmation for main tx
 *   5. Emit isSuccess + txHash
 *
 * Vault-direct actions (withdraw, cancelAndRefund) skip the approve step.
 *
 * Uses ethers v6. Accepts wagmi walletClient and converts to ethers Signer.
 */

import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { CONTRACTS, VAULT_ABI, ROUTER_ABI, ERC20_ABI, RPC_URL } from "../lib/contracts";

// ═══════════════════════════════════════════════════════════════
// ADAPTER: wagmi walletClient → ethers v6 Signer
// ═══════════════════════════════════════════════════════════════

async function walletClientToSigner(walletClient) {
  const { account, chain, transport } = walletClient;
  const provider = new ethers.BrowserProvider(transport, {
    chainId: chain.id,
    name: chain.name,
  });
  return provider.getSigner(account.address);
}

// ═══════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════

/**
 * @param {object|null} walletClient — from wagmi's useWalletClient()
 * @returns {object} Action functions and granular transaction state
 */
export function usePoolActions(walletClient) {
  const [isApproving, setIsApproving] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [txHash, setTxHash] = useState(null);
  const [error, setError] = useState(null);

  // ── Reset all state ──
  const reset = useCallback(() => {
    setIsApproving(false);
    setIsExecuting(false);
    setIsSuccess(false);
    setTxHash(null);
    setError(null);
  }, []);

  // ── Detect user signature rejection ──
  function isUserRejection(err) {
    return (
      err.code === "ACTION_REJECTED" ||
      err.code === 4001 ||
      (err.info && err.info.error && err.info.error.code === 4001) ||
      (err.message && err.message.includes("user rejected"))
    );
  }

  // ── Format error message ──
  function formatError(err) {
    if (isUserRejection(err)) return "Transacción rechazada por el usuario";
    return err.reason || err.shortMessage || err.message || "Error desconocido";
  }

  // ═══════════════════════════════════════════════════════════
  // CORE: approve → wait → execute → wait → success
  // Used by all Router-gated actions (USDC/MPOOLV3 deposits)
  // ═══════════════════════════════════════════════════════════

  const executeWithApproval = useCallback(
    async ({ tokenAddress, spender, amountWei, executeFn }) => {
      if (!walletClient) throw new Error("Wallet not connected");

      reset();

      try {
        const signer = await walletClientToSigner(walletClient);

        // ── Phase 1: Check allowance → Approve if needed ──
        setIsApproving(true);

        const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
        const owner = await signer.getAddress();
        const currentAllowance = await token.allowance(owner, spender);

        if (currentAllowance < amountWei) {
          // Request approve signature from user
          const approveTx = await token.approve(spender, amountWei);
          // Wait for 1 block confirmation
          await approveTx.wait(1);
        }

        setIsApproving(false);

        // ── Phase 2: Execute main transaction ──
        setIsExecuting(true);

        const tx = await executeFn(signer);
        setTxHash(tx.hash);

        // Wait for 1 block confirmation
        await tx.wait(1);

        setIsExecuting(false);

        // ── Phase 3: Success ──
        setIsSuccess(true);

        return { hash: tx.hash };
      } catch (err) {
        setIsApproving(false);
        setIsExecuting(false);
        setError(formatError(err));
        throw err;
      }
    },
    [walletClient, reset]
  );

  // ═══════════════════════════════════════════════════════════
  // CORE: direct execute (no approval step)
  // Used by Vault-direct actions (withdraw, cancelAndRefund)
  // ═══════════════════════════════════════════════════════════

  const executeDirectly = useCallback(
    async (executeFn) => {
      if (!walletClient) throw new Error("Wallet not connected");

      reset();

      try {
        const signer = await walletClientToSigner(walletClient);

        // ── Execute ──
        setIsExecuting(true);

        const tx = await executeFn(signer);
        setTxHash(tx.hash);

        await tx.wait(1);

        setIsExecuting(false);

        // ── Success ──
        setIsSuccess(true);

        return { hash: tx.hash };
      } catch (err) {
        setIsExecuting(false);
        setError(formatError(err));
        throw err;
      }
    },
    [walletClient, reset]
  );

  // ═══════════════════════════════════════════════════════════
  // ACTION 1a: Fund Premium with USDC (Insured)
  //   approve(USDC, Router, amount) → Router.fundPremiumWithUSDC(poolId, amount)
  // ═══════════════════════════════════════════════════════════

  const fundPremiumWithUSDC = useCallback(
    (poolId, usdcAmount) => {
      const amountWei = ethers.parseUnits(usdcAmount.toString(), 6);
      return executeWithApproval({
        tokenAddress: CONTRACTS.USDC,
        spender: CONTRACTS.ROUTER,
        amountWei,
        executeFn: (signer) => {
          const router = new ethers.Contract(CONTRACTS.ROUTER, ROUTER_ABI, signer);
          return router.fundPremiumWithUSDC(poolId, amountWei);
        },
      });
    },
    [executeWithApproval]
  );

  // ═══════════════════════════════════════════════════════════
  // ACTION 1b: Fund Premium with MPOOLV3 (Insured, Zap-In)
  //   approve(MPOOLV3, Router, mpoolAmount) → Router.fundPremiumWithMPOOL(poolId, mpoolAmount, minUsdcOut)
  // ═══════════════════════════════════════════════════════════

  const fundPremiumWithMPOOL = useCallback(
    (poolId, mpoolAmount, minUsdcOut) => {
      const mpoolWei = ethers.parseUnits(mpoolAmount.toString(), 18);
      const minOutWei = ethers.parseUnits(minUsdcOut.toString(), 6);
      return executeWithApproval({
        tokenAddress: CONTRACTS.MPOOLV3_TOKEN,
        spender: CONTRACTS.ROUTER,
        amountWei: mpoolWei,
        executeFn: (signer) => {
          const router = new ethers.Contract(CONTRACTS.ROUTER, ROUTER_ABI, signer);
          return router.fundPremiumWithMPOOL(poolId, mpoolWei, minOutWei);
        },
      });
    },
    [executeWithApproval]
  );

  // ═══════════════════════════════════════════════════════════
  // ACTION 2a: Join Pool with USDC (Provider)
  //   approve(USDC, Router, amount) → Router.joinPoolWithUSDC(poolId, amount)
  // ═══════════════════════════════════════════════════════════

  const joinPoolWithUSDC = useCallback(
    (poolId, usdcAmount) => {
      const amountWei = ethers.parseUnits(usdcAmount.toString(), 6);
      return executeWithApproval({
        tokenAddress: CONTRACTS.USDC,
        spender: CONTRACTS.ROUTER,
        amountWei,
        executeFn: (signer) => {
          const router = new ethers.Contract(CONTRACTS.ROUTER, ROUTER_ABI, signer);
          return router.joinPoolWithUSDC(poolId, amountWei);
        },
      });
    },
    [executeWithApproval]
  );

  // ═══════════════════════════════════════════════════════════
  // ACTION 2b: Join Pool with MPOOLV3 (Provider, Zap-In)
  //   approve(MPOOLV3, Router, mpoolAmount) → Router.joinPoolWithMPOOL(poolId, mpoolAmount, minUsdcOut)
  // ═══════════════════════════════════════════════════════════

  const joinPoolWithMPOOL = useCallback(
    (poolId, mpoolAmount, minUsdcOut) => {
      const mpoolWei = ethers.parseUnits(mpoolAmount.toString(), 18);
      const minOutWei = ethers.parseUnits(minUsdcOut.toString(), 6);
      return executeWithApproval({
        tokenAddress: CONTRACTS.MPOOLV3_TOKEN,
        spender: CONTRACTS.ROUTER,
        amountWei: mpoolWei,
        executeFn: (signer) => {
          const router = new ethers.Contract(CONTRACTS.ROUTER, ROUTER_ABI, signer);
          return router.joinPoolWithMPOOL(poolId, mpoolWei, minOutWei);
        },
      });
    },
    [executeWithApproval]
  );

  // ═══════════════════════════════════════════════════════════
  // ACTION 3: Withdraw (Post-resolution, Vault-direct)
  //   Vault.withdraw(poolId)
  // ═══════════════════════════════════════════════════════════

  const withdraw = useCallback(
    (poolId) =>
      executeDirectly((signer) => {
        const vault = new ethers.Contract(CONTRACTS.MUTUAL_POOL_V3, VAULT_ABI, signer);
        return vault.withdraw(poolId);
      }),
    [executeDirectly]
  );

  // ═══════════════════════════════════════════════════════════
  // ACTION 4: Cancel & Refund (Vault-direct)
  //   Vault.cancelAndRefund(poolId)
  // ═══════════════════════════════════════════════════════════

  const cancelAndRefund = useCallback(
    (poolId) =>
      executeDirectly((signer) => {
        const vault = new ethers.Contract(CONTRACTS.MUTUAL_POOL_V3, VAULT_ABI, signer);
        return vault.cancelAndRefund(poolId);
      }),
    [executeDirectly]
  );

  // ═══════════════════════════════════════════════════════════
  // QUOTE: MPOOLV3 → USDC (read-only, no state changes)
  // Uses public RPC — no wallet required
  // ═══════════════════════════════════════════════════════════

  const quoteMpoolToUsdc = useCallback(async (mpoolAmount) => {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const router = new ethers.Contract(CONTRACTS.ROUTER, ROUTER_ABI, provider);
    const mpoolWei = ethers.parseUnits(mpoolAmount.toString(), 18);
    const usdcOut = await router.quoteMpoolToUsdc(mpoolWei);
    return ethers.formatUnits(usdcOut, 6);
  }, []);

  return {
    // Actions
    fundPremiumWithUSDC,
    fundPremiumWithMPOOL,
    joinPoolWithUSDC,
    joinPoolWithMPOOL,
    withdraw,
    cancelAndRefund,
    quoteMpoolToUsdc,

    // Granular state
    isApproving,
    isExecuting,
    isSuccess,
    txHash,
    error,
    reset,
  };
}
