import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { ethers } from "ethers";
import { CONTRACTS, VAULT_ABI, RPC_URL, POOL_STATUS, POOL_STATUS_COLORS } from "../lib/contracts";

/**
 * PoolList — Browse all pools on the protocol.
 *
 * Reads nextPoolId from the vault, then fetches each pool's summary.
 * No wallet connection required (read-only via public RPC).
 */
export default function PoolList() {
  const [pools, setPools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [totalPools, setTotalPools] = useState(0);

  useEffect(() => {
    async function fetchPools() {
      try {
        const provider = window.ethereum
          ? new ethers.BrowserProvider(window.ethereum)
          : new ethers.JsonRpcProvider(RPC_URL);

        const vault = new ethers.Contract(CONTRACTS.MUTUAL_POOL_V3, VAULT_ABI, provider);
        const nextId = Number(await vault.nextPoolId());
        setTotalPools(nextId);

        if (nextId === 0) {
          setLoading(false);
          return;
        }

        // Fetch last 20 pools (most recent first)
        const start = Math.max(0, nextId - 20);
        const poolPromises = [];
        for (let i = nextId - 1; i >= start; i--) {
          poolPromises.push(
            vault.getPool(i).then((data) => ({
              id: i,
              description: data.description,
              coverageAmount: ethers.formatUnits(data.coverageAmount, 6),
              premiumRate: Number(data.premiumRate),
              deadline: Number(data.deadline),
              totalCollateral: ethers.formatUnits(data.totalCollateral, 6),
              status: Number(data.status),
              statusLabel: POOL_STATUS[Number(data.status)] || "Unknown",
              participantCount: Number(data.participantCount),
              fillPercentage:
                Number(data.coverageAmount) > 0
                  ? Math.min(100, (Number(data.totalCollateral) / Number(data.coverageAmount)) * 100)
                  : 0,
            }))
          );
        }

        const results = await Promise.all(poolPromises);
        setPools(results);
      } catch (err) {
        console.error("Failed to fetch pools:", err);
      } finally {
        setLoading(false);
      }
    }

    fetchPools();
  }, []);

  if (loading) {
    return (
      <div className="pool-list">
        <h2>Loading pools...</h2>
      </div>
    );
  }

  return (
    <div className="pool-list">
      <div className="pool-list-header">
        <h2>Insurance Pools</h2>
        <span className="pool-count">{totalPools} total</span>
      </div>

      {pools.length === 0 ? (
        <p className="empty-state">No pools created yet.</p>
      ) : (
        <div className="pool-grid">
          {pools.map((pool) => (
            <Link to={`/pool/${pool.id}`} key={pool.id} className="pool-card-link">
              <div className="pool-card-mini">
                <div className="card-top">
                  <span className="pool-id">#{pool.id}</span>
                  <span
                    className="status-badge-sm"
                    style={{ backgroundColor: POOL_STATUS_COLORS[pool.status] }}
                  >
                    {pool.statusLabel}
                  </span>
                </div>

                <p className="card-description">
                  {pool.description.length > 80
                    ? pool.description.slice(0, 80) + "..."
                    : pool.description}
                </p>

                <div className="card-stats">
                  <span>
                    {Number(pool.coverageAmount).toLocaleString()} USDC
                  </span>
                  <span>{pool.premiumRate / 100}% rate</span>
                  <span>{pool.participantCount} providers</span>
                </div>

                {(pool.status === 1 || pool.status === 2) && (
                  <div className="progress-container-sm">
                    <div
                      className="progress-bar-sm"
                      style={{ width: `${pool.fillPercentage}%` }}
                    />
                  </div>
                )}

                <div className="card-deadline">
                  {new Date(pool.deadline * 1000).toLocaleDateString()}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
