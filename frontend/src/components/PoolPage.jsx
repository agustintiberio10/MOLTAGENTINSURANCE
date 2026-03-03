/**
 * PoolPage — Main dApp page for /pool/:id
 *
 * Architecture:
 *   URL: https://mutualpool.finance/pool/42?action=fund_premium|provide_collateral|withdraw
 *
 *   1. Reads pool data from MutualLumina via usePool hook (public RPC, no wallet needed)
 *   2. Wallet managed by RainbowKit/Wagmi (useAccount, useWalletClient)
 *   3. Context-Aware Auto-Fill:
 *      - ?action=fund_premium → hides inputs, reads premiumAmount from Vault, one-click button
 *      - ?action=provide_collateral → pre-fills amount if &amount= present in URL
 *      - ?action=withdraw → shows withdraw button directly
 *   4. Granular state buttons:
 *      - isApproving → "Aprobando USDC..."
 *      - isExecuting → "Pagando Prima..." / "Depositando..." / etc.
 *      - isSuccess → "TX confirmada" + basescan link
 *   5. Executes transactions via usePoolActions → MutualLumina direct
 */

import React, { useState, useMemo, useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useAccount, useWalletClient } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { usePool } from "../hooks/usePool";
import { usePoolActions } from "../hooks/usePoolActions";
import { LUMINA_POOL_STATUS_COLORS, CONTRACTS, CHAIN_ID } from "../lib/contracts";

export default function PoolPage() {
  const { id: poolId } = useParams();
  const [searchParams] = useSearchParams();
  const suggestedAction = searchParams.get("action"); // fund_premium | provide_collateral | withdraw
  const suggestedAmount = searchParams.get("amount"); // optional pre-fill for provide_collateral

  // ── Wagmi hooks ──
  const { address, isConnected, chain } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { openConnectModal } = useConnectModal();
  const isBase = chain?.id === CHAIN_ID;

  // ── Pool data (read-only, public RPC) ──
  const { pool, loading: poolLoading, error: poolError, refetch } = usePool(poolId);

  // ── Actions (granular state) ──
  const actions = usePoolActions(walletClient);

  // ── Local state ──
  const [depositAmount, setDepositAmount] = useState(suggestedAmount || "");

  // ── Auto-fill amount from URL param ──
  useEffect(() => {
    if (suggestedAmount && !depositAmount) {
      setDepositAmount(suggestedAmount);
    }
  }, [suggestedAmount]);

  // ── Derived: user role ──
  const userRole = useMemo(() => {
    if (!pool || !address) return null;
    if (pool.insured.toLowerCase() === address.toLowerCase()) return "insured";
    const isProvider = pool.participants.some(
      (p) => p.toLowerCase() === address.toLowerCase()
    );
    if (isProvider) return "provider";
    return "new";
  }, [pool, address]);

  // ── Is deep-linked action? (context-aware auto-fill) ──
  const isAutoFillPremium = suggestedAction === "fund_premium";
  const isAutoFillCollateral = suggestedAction === "provide_collateral";
  const isAutoFillWithdraw = suggestedAction === "withdraw";

  // ── Handlers ──

  const handleFundPremium = async () => {
    if (!pool) return;
    try {
      await actions.fundPremiumWithUSDC(poolId, pool.requiredPremium);
      refetch();
    } catch {
      // Error already captured in actions.error
    }
  };

  const handleJoinPool = async () => {
    if (!depositAmount || Number(depositAmount) < 10) return;
    try {
      await actions.joinPoolWithUSDC(poolId, depositAmount);
      refetch();
    } catch {
      // Error already captured in actions.error
    }
  };

  const handleWithdraw = async () => {
    try {
      await actions.withdraw(poolId);
      refetch();
    } catch {
      // Error already captured
    }
  };

  const handleCancel = async () => {
    try {
      await actions.cancelAndRefund(poolId);
      refetch();
    } catch {
      // Error already captured
    }
  };

  // ── Helper: check if any action is in progress ──
  const isBusy = actions.isApproving || actions.isExecuting;

  // ═══════════════════════════════════════════════════
  // Button label generators (granular state)
  // ═══════════════════════════════════════════════════

  function premiumButtonLabel() {
    if (actions.isApproving) return "Aprobando USDC...";
    if (actions.isExecuting) return "Pagando Prima...";
    return `Pagar Prima ${Number(pool.requiredPremium).toLocaleString()} USDC`;
  }

  function collateralButtonLabel() {
    if (actions.isApproving) return "Aprobando USDC...";
    if (actions.isExecuting) return "Depositando Colateral...";
    return `Depositar ${depositAmount || "0"} USDC`;
  }

  function withdrawButtonLabel() {
    if (actions.isExecuting) return "Retirando Fondos...";
    return "Retirar Fondos";
  }

  function cancelButtonLabel() {
    if (actions.isExecuting) return "Cancelando...";
    return "Cancelar & Reembolsar";
  }

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
            style={{ backgroundColor: LUMINA_POOL_STATUS_COLORS[pool.status] }}
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
              {Number(pool.premiumPaid).toLocaleString()} USDC (
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
        {(pool.status === 1 || pool.status === 0) && (
          <div className="progress-container">
            <div className="progress-bar" style={{ width: `${pool.fillPercentage}%` }} />
            <span className="progress-label">{pool.fillPercentage.toFixed(1)}% funded</span>
          </div>
        )}
      </div>

      {/* ── Wallet Connection (RainbowKit modal) ── */}
      {!isConnected && (
        <div className="connect-panel">
          <p>Conecta tu wallet para interactuar con este pool.</p>
          <button onClick={openConnectModal} className="btn btn-primary">
            Conectar Wallet
          </button>
        </div>
      )}

      {isConnected && !isBase && (
        <div className="chain-warning">
          <p>Red incorrecta. Cambia a Base desde tu wallet.</p>
        </div>
      )}

      {/* ── Action Panel ── */}
      {isConnected && isBase && (
        <div className="action-panel">

          {/* ═══════════════════════════════════════════
              OPEN: Provide Collateral (USDC only)
              Context-Aware: ?action=provide_collateral&amount=X → pre-filled
              ═══════════════════════════════════════════ */}
          {pool.status === 0 && pool.isDepositOpen && userRole !== "insured" && (
            <div className="action-section">
              <h3>Proveer Colateral</h3>

              <input
                type="number"
                placeholder="Cantidad (USDC, min 10)"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                min="10"
                step="any"
              />

              <p className="hint">
                Restante: {(Number(pool.coverageAmount) - Number(pool.totalCollateral)).toLocaleString()} USDC
              </p>

              <button
                onClick={handleJoinPool}
                disabled={isBusy || !depositAmount || Number(depositAmount) < 10}
                className="btn btn-primary"
              >
                {collateralButtonLabel()}
              </button>
            </div>
          )}

          {/* ═══════════════════════════════════════════
              RESOLVED: Withdraw
              Context-Aware: ?action=withdraw → direct button
              ═══════════════════════════════════════════ */}
          {pool.status === 2 && (userRole === "provider" || userRole === "insured") && (
            <div className="action-section">
              <h3>Retirar Fondos</h3>
              <p>
                Pool resuelto: {pool.claimApproved ? "Reclamo Aprobado" : "Sin Reclamo"}
              </p>
              <button
                onClick={handleWithdraw}
                disabled={isBusy}
                className="btn btn-success"
              >
                {withdrawButtonLabel()}
              </button>
            </div>
          )}

          {/* ═══════════════════════════════════════════
              CANCELLED or underfunded past deadline: Cancel & Refund
              ═══════════════════════════════════════════ */}
          {(pool.status === 0 || pool.status === 1) &&
            !pool.isDepositOpen &&
            Number(pool.totalCollateral) < Number(pool.coverageAmount) && (
              <div className="action-section">
                <h3>Cancelar & Reembolsar</h3>
                <p>Pool sin fondos suficientes. Cualquiera puede cancelar.</p>
                <button
                  onClick={handleCancel}
                  disabled={isBusy}
                  className="btn btn-danger"
                >
                  {cancelButtonLabel()}
                </button>
              </div>
            )}

          {/* ── TX Feedback (granular) ── */}
          {actions.isSuccess && actions.txHash && (
            <div className="tx-feedback success">
              TX confirmada:{" "}
              <a
                href={`https://basescan.org/tx/${actions.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {actions.txHash.slice(0, 10)}...{actions.txHash.slice(-6)}
              </a>
            </div>
          )}
          {actions.error && (
            <div className="tx-feedback error">
              Error: {actions.error}
              <button
                onClick={actions.reset}
                className="btn btn-primary"
                style={{ marginLeft: 12, padding: "4px 12px", fontSize: 12 }}
              >
                Reintentar
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Contract Info Footer ── */}
      <div className="contract-info">
        <p>
          Vault:{" "}
          <a
            href={`https://basescan.org/address/${CONTRACTS.MUTUAL_LUMINA}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {CONTRACTS.MUTUAL_LUMINA}
          </a>
        </p>
      </div>
    </div>
  );
}
