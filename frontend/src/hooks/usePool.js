/**
 * usePool — React hook for reading MutualPoolV3 pool data.
 *
 * Usage:
 *   const { pool, loading, error, refetch } = usePool(poolId);
 *
 * Architecture:
 *   Always uses public RPC (read-only). No wallet connection required.
 *   Provides all pool data including requiredPremium and participants.
 */

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { CONTRACTS, VAULT_ABI, RPC_URL, POOL_STATUS } from "../lib/contracts";

/**
 * @param {number|string} poolId
 * @returns {{ pool: object|null, loading: boolean, error: string|null, refetch: Function }}
 */
export function usePool(poolId) {
  const [pool, setPool] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchPool = useCallback(async () => {
    if (poolId === undefined || poolId === null) return;

    setLoading(true);
    setError(null);

    try {
      // Always use public RPC for reads — no wallet dependency
      const provider = new ethers.JsonRpcProvider(RPC_URL);

      const vault = new ethers.Contract(CONTRACTS.MUTUAL_POOL_V3, VAULT_ABI, provider);
      const data = await vault.getPool(poolId);
      const requiredPremium = await vault.getRequiredPremium(poolId);
      const participants = await vault.getPoolParticipants(poolId);

      setPool({
        id: Number(poolId),
        description: data.description,
        evidenceSource: data.evidenceSource,
        coverageAmount: ethers.formatUnits(data.coverageAmount, 6),
        coverageAmountRaw: data.coverageAmount,
        premiumRate: Number(data.premiumRate),
        deadline: Number(data.deadline),
        depositDeadline: Number(data.depositDeadline),
        insured: data.insured,
        premiumPaid: ethers.formatUnits(data.premiumPaid, 6),
        premiumPaidRaw: data.premiumPaid,
        totalCollateral: ethers.formatUnits(data.totalCollateral, 6),
        totalCollateralRaw: data.totalCollateral,
        status: Number(data.status),
        statusLabel: POOL_STATUS[Number(data.status)] || "Unknown",
        claimApproved: data.claimApproved,
        participantCount: Number(data.participantCount),
        participants,
        requiredPremium: ethers.formatUnits(requiredPremium, 6),
        requiredPremiumRaw: requiredPremium,
        // Derived
        isDepositOpen: Date.now() / 1000 < Number(data.depositDeadline),
        isDeadlinePassed: Date.now() / 1000 >= Number(data.deadline),
        fillPercentage:
          Number(data.coverageAmount) > 0
            ? Math.min(100, (Number(data.totalCollateral) / Number(data.coverageAmount)) * 100)
            : 0,
      });
    } catch (err) {
      setError(err.message || "Failed to fetch pool data");
    } finally {
      setLoading(false);
    }
  }, [poolId]);

  useEffect(() => {
    fetchPool();
  }, [fetchPool]);

  return { pool, loading, error, refetch: fetchPool };
}
