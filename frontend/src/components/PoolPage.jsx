/**
 * PoolPage — Main dApp page for /pool/:id
 *
 * Architecture:
 *   URL: https://mutualpool.finance/pool/42?action=fund_premium|provide_collateral|withdraw
 *
 *   1. Reads pool data from MutualPoolV3 via usePool hook
 *   2. Detects wallet connection via useWallet hook
 *   3. Shows context-aware action buttons based on:
 *      - Pool status (Pending/Open/Active/Resolved/Cancelled)
 *      - Query param ?action= (deep-link from M2M payload)
 *      - User role (is insured? is provider? is new?)
 *   4. Executes transactions via usePoolActions → Router or Vault
 *
 *   ┌─────────────────────────────────────────────────┐
 *   │  /pool/:id                                      │
 *   │                                                  │
 *   │  ┌──────────────────────────────────────┐       │
 *   │  │ Pool Info Card                        │       │
 *   │  │ Description, coverage, premium, etc.  │       │
 *   │  │ Status badge + progress bar           │       │
 *   │  └──────────────────────────────────────┘       │
 *   │                                                  │
 *   │  ┌──────────────────────────────────────┐       │
 *   │  │ Action Panel (context-aware)          │       │
 *   │  │                                       │       │
 *   │  │ Pending:  [Pay Premium X USDC]        │       │
 *   │  │ Open:     [Deposit Collateral]        │       │
 *   │  │           [Token: USDC | MPOOLV3]     │       │
 *   │  │ Resolved: [Withdraw Funds]            │       │
 *   │  │ Cancelled:[Claim Refund]              │       │
 *   │  └──────────────────────────────────────┘       │
 *   │                                                  │
 *   │  ┌──────────────────────────────────────┐       │
 *   │  │ Participants Table                    │       │
 *   │  │ Address | Contribution | Status       │       │
 *   │  └──────────────────────────────────────┘       │
 *   └─────────────────────────────────────────────────┘
 */

import React, { useState, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { ethers } from "ethers";
import { usePool } from "../hooks/usePool";
import { useWallet } from "../hooks/useWallet";
import { usePoolActions } from "../hooks/usePoolActions";
import { POOL_STATUS, POOL_STATUS_COLORS, CONTRACTS } from "../lib/contracts";

export default function PoolPage() {
  const { id: poolId } = useParams();
  const [searchParams] = useSearchParams();
  const suggestedAction = searchParams.get("action"); // fund_premium | provide_collateral | withdraw

  // ── Hooks ──
  const { pool, loading: poolLoading, error: poolError, refetch } = usePool(poolId);
  const { address, signer, connected, isBase, connect, switchToBase } = useWallet();
  const actions = usePoolActions(signer);

  // ── Local state ──
  const [depositAmount, setDepositAmount] = useState("");
  const [tokenMode, setTokenMode] = useState("usdc"); // "usdc" | "mpoolv3"
  const [premiumTokenMode, setPremiumTokenMode] = useState("usdc"); // "usdc" | "mpoolv3"
  const [premiumMpoolAmount, setPremiumMpoolAmount] = useState("");
  const [mpoolQuote, setMpoolQuote] = useState(null);
  const [premiumMpoolQuote, setPremiumMpoolQuote] = useState(null);

  // ── Derived state ──
  const userRole = useMemo(() => {
    if (!pool || !address) return null;
    if (pool.insured.toLowerCase() === address.toLowerCase()) return "insured";
    const isProvider = pool.participants.some(
      (p) => p.toLowerCase() === address.toLowerCase()
    );
    if (isProvider) return "provider";
    return "new";
  }, [pool, address]);

  // ── Handlers ──

  const handleFundPremium = async () => {
    if (!pool) return;

    if (premiumTokenMode === "usdc") {
      await actions.fundPremiumWithUSDC(poolId, pool.requiredPremium);
    } else {
      // MPOOLV3 mode — quote and swap
      if (!premiumMpoolAmount || Number(premiumMpoolAmount) <= 0) return;
      const quote = await actions.quoteMpoolToUsdc(premiumMpoolAmount);
      const minOut = (Number(quote) * 0.97).toFixed(6);
      await actions.fundPremiumWithMPOOL(poolId, premiumMpoolAmount, minOut);
    }
    refetch();
  };

  const handleQuotePremiumMpool = async (amount) => {
    if (!amount || Number(amount) <= 0) {
      setPremiumMpoolQuote(null);
      return;
    }
    try {
      const quote = await actions.quoteMpoolToUsdc(amount);
      setPremiumMpoolQuote(quote);
    } catch {
      setPremiumMpoolQuote(null);
    }
  };

  const handleJoinPool = async () => {
    if (!depositAmount || Number(depositAmount) < 10) return;

    if (tokenMode === "usdc") {
      await actions.joinPoolWithUSDC(poolId, depositAmount);
    } else {
      // MPOOLV3 mode — use quote for minUsdcOut with 3% slippage
      const quote = await actions.quoteMpoolToUsdc(depositAmount);
      const minOut = (Number(quote) * 0.97).toFixed(6);
      await actions.joinPoolWithMPOOL(poolId, depositAmount, minOut);
    }
    refetch();
  };

  const handleWithdraw = async () => {
    await actions.withdraw(poolId);
    refetch();
  };

  const handleCancel = async () => {
    await actions.cancelAndRefund(poolId);
    refetch();
  };

  const handleQuoteMpool = async (amount) => {
    if (!amount || Number(amount) <= 0) {
      setMpoolQuote(null);
      return;
    }
    try {
      const quote = await actions.quoteMpoolToUsdc(amount);
      setMpoolQuote(quote);
    } catch {
      setMpoolQuote(null);
    }
  };

  // ── Render ──

  if (poolLoading) {
    return <div className="pool-page loading">Loading pool #{poolId}...</div>;
  }

  if (poolError) {
    return <div className="pool-page error">Error: {poolError}</div>;
  }

  if (!pool) {
    return <div className="pool-page not-found">Pool #{poolId} not found</div>;
  }

  return (
    <div className="pool-page">
      {/* ── Pool Info Card ── */}
      <div className="pool-card">
        <div className="pool-header">
          <h1>Pool #{pool.id}</h1>
          <span
            className="status-badge"
            style={{ backgroundColor: POOL_STATUS_COLORS[pool.status] }}
          >
            {pool.statusLabel}
          </span>
        </div>

        <p className="description">{pool.description}</p>

        <div className="pool-stats">
          <div className="stat">
            <label>Coverage</label>
            <span>{Number(pool.coverageAmount).toLocaleString()} USDC</span>
          </div>
          <div className="stat">
            <label>Premium</label>
            <span>
              {Number(pool.requiredPremium).toLocaleString()} USDC (
              {(pool.premiumRate / 100).toFixed(1)}%)
            </span>
          </div>
          <div className="stat">
            <label>Collateral</label>
            <span>
              {Number(pool.totalCollateral).toLocaleString()} /{" "}
              {Number(pool.coverageAmount).toLocaleString()} USDC
            </span>
          </div>
          <div className="stat">
            <label>Providers</label>
            <span>{pool.participantCount}</span>
          </div>
          <div className="stat">
            <label>Deadline</label>
            <span>{new Date(pool.deadline * 1000).toLocaleString()}</span>
          </div>
          <div className="stat">
            <label>Deposit Deadline</label>
            <span>
              {new Date(pool.depositDeadline * 1000).toLocaleString()}
              {pool.isDepositOpen ? " (open)" : " (closed)"}
            </span>
          </div>
          <div className="stat">
            <label>Evidence</label>
            <a href={pool.evidenceSource} target="_blank" rel="noopener noreferrer">
              {pool.evidenceSource}
            </a>
          </div>
        </div>

        {/* ── Progress Bar ── */}
        {(pool.status === 1 || pool.status === 2) && (
          <div className="progress-container">
            <div className="progress-bar" style={{ width: `${pool.fillPercentage}%` }} />
            <span className="progress-label">{pool.fillPercentage.toFixed(1)}% funded</span>
          </div>
        )}
      </div>

      {/* ── Wallet Connection ── */}
      {!connected && (
        <div className="connect-panel">
          <button onClick={connect} className="btn btn-primary">
            Connect Wallet (MetaMask / Rabby)
          </button>
        </div>
      )}

      {connected && !isBase && (
        <div className="chain-warning">
          <p>Wrong network. Please switch to Base.</p>
          <button onClick={switchToBase} className="btn btn-warning">
            Switch to Base
          </button>
        </div>
      )}

      {/* ── Action Panel ── */}
      {connected && isBase && (
        <div className="action-panel">
          {/* PENDING: Fund Premium */}
          {pool.status === 0 && pool.isDepositOpen && (
            <div className="action-section">
              <h3>Pay Premium (Become Insured)</h3>
              <p>
                Premium: <strong>{Number(pool.requiredPremium).toLocaleString()} USDC</strong>
              </p>

              {/* Token selector for premium */}
              <div className="token-selector">
                <button
                  className={`token-btn ${premiumTokenMode === "usdc" ? "active" : ""}`}
                  onClick={() => setPremiumTokenMode("usdc")}
                >
                  USDC
                </button>
                <button
                  className={`token-btn ${premiumTokenMode === "mpoolv3" ? "active" : ""}`}
                  onClick={() => setPremiumTokenMode("mpoolv3")}
                >
                  MPOOLV3
                </button>
              </div>

              {premiumTokenMode === "mpoolv3" && (
                <>
                  <input
                    type="number"
                    placeholder="Amount (MPOOLV3)"
                    value={premiumMpoolAmount}
                    onChange={(e) => {
                      setPremiumMpoolAmount(e.target.value);
                      handleQuotePremiumMpool(e.target.value);
                    }}
                    min="1"
                    step="any"
                  />
                  {premiumMpoolQuote && (
                    <p className="quote-preview">
                      Estimated output: ~{Number(premiumMpoolQuote).toFixed(2)} USDC (need {Number(pool.requiredPremium).toLocaleString()} USDC, 3% slippage protection)
                    </p>
                  )}
                </>
              )}

              <p className="hint">
                Your address ({address?.slice(0, 6)}...{address?.slice(-4)}) will be set as the
                insured. You will receive the coverage payout if the claim is approved.
              </p>
              <button
                onClick={handleFundPremium}
                disabled={actions.loading || (premiumTokenMode === "mpoolv3" && !premiumMpoolAmount)}
                className="btn btn-primary"
              >
                {actions.loading
                  ? "Processing..."
                  : premiumTokenMode === "usdc"
                    ? `Pay Premium ${Number(pool.requiredPremium).toLocaleString()} USDC`
                    : `Swap & Pay Premium ${premiumMpoolAmount || "0"} MPOOLV3`}
              </button>
            </div>
          )}

          {/* OPEN: Provide Collateral */}
          {pool.status === 1 && pool.isDepositOpen && userRole !== "insured" && (
            <div className="action-section">
              <h3>Provide Collateral</h3>

              {/* Token selector */}
              <div className="token-selector">
                <button
                  className={`token-btn ${tokenMode === "usdc" ? "active" : ""}`}
                  onClick={() => setTokenMode("usdc")}
                >
                  USDC
                </button>
                <button
                  className={`token-btn ${tokenMode === "mpoolv3" ? "active" : ""}`}
                  onClick={() => setTokenMode("mpoolv3")}
                >
                  MPOOLV3
                </button>
              </div>

              <input
                type="number"
                placeholder={tokenMode === "usdc" ? "Amount (USDC, min 10)" : "Amount (MPOOLV3)"}
                value={depositAmount}
                onChange={(e) => {
                  setDepositAmount(e.target.value);
                  if (tokenMode === "mpoolv3") handleQuoteMpool(e.target.value);
                }}
                min={tokenMode === "usdc" ? "10" : "1"}
                step="any"
              />

              {/* MPOOLV3 quote preview */}
              {tokenMode === "mpoolv3" && mpoolQuote && (
                <p className="quote-preview">
                  Estimated output: ~{Number(mpoolQuote).toFixed(2)} USDC (3% slippage protection)
                </p>
              )}

              <p className="hint">
                Remaining: {(Number(pool.coverageAmount) - Number(pool.totalCollateral)).toLocaleString()} USDC needed
              </p>

              <button
                onClick={handleJoinPool}
                disabled={
                  actions.loading ||
                  !depositAmount ||
                  (tokenMode === "usdc" && Number(depositAmount) < 10)
                }
                className="btn btn-primary"
              >
                {actions.loading
                  ? "Processing..."
                  : tokenMode === "usdc"
                    ? `Deposit ${depositAmount || "0"} USDC`
                    : `Swap & Deposit ${depositAmount || "0"} MPOOLV3`}
              </button>
            </div>
          )}

          {/* RESOLVED: Withdraw */}
          {pool.status === 3 && (userRole === "provider" || userRole === "insured") && (
            <div className="action-section">
              <h3>Withdraw Funds</h3>
              <p>
                Pool resolved: {pool.claimApproved ? "Claim Approved" : "No Claim"}
              </p>
              <button
                onClick={handleWithdraw}
                disabled={actions.loading}
                className="btn btn-success"
              >
                {actions.loading ? "Processing..." : "Withdraw"}
              </button>
            </div>
          )}

          {/* CANCELLED or OPEN past deadline: Cancel & Refund */}
          {(pool.status === 1 || pool.status === 0) &&
            !pool.isDepositOpen &&
            Number(pool.totalCollateral) < Number(pool.coverageAmount) && (
              <div className="action-section">
                <h3>Cancel & Refund</h3>
                <p>Pool is underfunded past deposit deadline. Anyone can trigger cancellation.</p>
                <button
                  onClick={handleCancel}
                  disabled={actions.loading}
                  className="btn btn-danger"
                >
                  {actions.loading ? "Processing..." : "Cancel & Refund All"}
                </button>
              </div>
            )}

          {/* TX feedback */}
          {actions.txHash && (
            <div className="tx-feedback success">
              TX confirmed:{" "}
              <a
                href={`https://basescan.org/tx/${actions.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {actions.txHash.slice(0, 10)}...
              </a>
            </div>
          )}
          {actions.error && <div className="tx-feedback error">Error: {actions.error}</div>}
        </div>
      )}

      {/* ── Contract Info Footer ── */}
      <div className="contract-info">
        <p>
          Vault:{" "}
          <a
            href={`https://basescan.org/address/${CONTRACTS.MUTUAL_POOL_V3}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {CONTRACTS.MUTUAL_POOL_V3}
          </a>
        </p>
        <p>
          Router:{" "}
          <a
            href={`https://basescan.org/address/${CONTRACTS.ROUTER}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {CONTRACTS.ROUTER}
          </a>
        </p>
      </div>
    </div>
  );
}
