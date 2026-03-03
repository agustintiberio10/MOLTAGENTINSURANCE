/**
 * usePoolActions — React hook for executing pool transactions on MutualLumina.
 *
 * Granular state machine:
 *   idle → isApproving → isExecuting → isSuccess
 *                ↘          ↘
 *                 error       error
 *
 * Every ERC-20 action follows the approve→wait→execute→wait→success pattern:
 *   1. Check allowance — if insufficient, request USDC approve signature
 *   2. Wait 1 block confirmation for approve tx
 *   3. Switch state to isExecuting — request Lumina method signature
 *   4. Wait 1 block confirmation for main tx
 *   5. Emit isSuccess + txHash
 *
 * Vault-direct actions (withdraw, cancelAndRefund) skip the approve step.
 *
 * Uses ethers v6. Accepts wagmi walletClient and converts to ethers Signer.
 */

import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { CONTRACTS, LUMINA_ABI, ERC20_ABI } from "../lib/contracts";

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
  // Used by all USDC deposit actions
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
          const approveTx = await token.approve(spender, amountWei);
          await approveTx.wait(1);
        }

        setIsApproving(false);

        // ── Phase 2: Execute main transaction ──
        setIsExecuting(true);

        const tx = await executeFn(signer);
        setTxHash(tx.hash);

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

        setIsExecuting(true);

        const tx = await executeFn(signer);
        setTxHash(tx.hash);

        await tx.wait(1);

        setIsExecuting(false);

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
  // ACTION 1: Fund Premium with USDC (Insured)
  //   approve(USDC, Lumina, amount) → Lumina.joinPool(poolId, amount)
  // ═══════════════════════════════════════════════════════════

  const fundPremiumWithUSDC = useCallback(
    (poolId, usdcAmount) => {
      const amountWei = ethers.parseUnits(usdcAmount.toString(), 6);
      return executeWithApproval({
        tokenAddress: CONTRACTS.USDC,
        spender: CONTRACTS.MUTUAL_LUMINA,
        amountWei,
        executeFn: (signer) => {
          const lumina = new ethers.Contract(CONTRACTS.MUTUAL_LUMINA, LUMINA_ABI, signer);
          return lumina.joinPool(poolId, amountWei);
        },
      });
    },
    [executeWithApproval]
  );

  // ═══════════════════════════════════════════════════════════
  // ACTION 2: Join Pool with USDC (Provider)
  //   approve(USDC, Lumina, amount) → Lumina.joinPool(poolId, amount)
  // ═══════════════════════════════════════════════════════════

  const joinPoolWithUSDC = useCallback(
    (poolId, usdcAmount) => {
      const amountWei = ethers.parseUnits(usdcAmount.toString(), 6);
      return executeWithApproval({
        tokenAddress: CONTRACTS.USDC,
        spender: CONTRACTS.MUTUAL_LUMINA,
        amountWei,
        executeFn: (signer) => {
          const lumina = new ethers.Contract(CONTRACTS.MUTUAL_LUMINA, LUMINA_ABI, signer);
          return lumina.joinPool(poolId, amountWei);
        },
      });
    },
    [executeWithApproval]
  );

  // ═══════════════════════════════════════════════════════════
  // ACTION 3: Withdraw (Post-resolution, Vault-direct)
  //   Lumina.withdraw(poolId)
  // ═══════════════════════════════════════════════════════════

  const withdraw = useCallback(
    (poolId) =>
      executeDirectly((signer) => {
        const lumina = new ethers.Contract(CONTRACTS.MUTUAL_LUMINA, LUMINA_ABI, signer);
        return lumina.withdraw(poolId);
      }),
    [executeDirectly]
  );

  // ═══════════════════════════════════════════════════════════
  // ACTION 4: Cancel & Refund (Vault-direct)
  //   Lumina.cancelAndRefund(poolId)
  // ═══════════════════════════════════════════════════════════

  const cancelAndRefund = useCallback(
    (poolId) =>
      executeDirectly((signer) => {
        const lumina = new ethers.Contract(CONTRACTS.MUTUAL_LUMINA, LUMINA_ABI, signer);
        return lumina.cancelAndRefund(poolId);
      }),
    [executeDirectly]
  );

  return {
    // Actions
    fundPremiumWithUSDC,
    joinPoolWithUSDC,
    withdraw,
    cancelAndRefund,

    // Granular state
    isApproving,
    isExecuting,
    isSuccess,
    txHash,
    error,
    reset,
  };
}
