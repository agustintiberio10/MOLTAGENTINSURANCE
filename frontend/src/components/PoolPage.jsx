/**
 * PoolPage — Main dApp page for /pool/:id
 *
 * Architecture:
 *   URL: https://mutualpool.finance/pool/42?action=fund_premium|provide_collateral|withdraw
 *
 *   1. Reads pool data from MutualPoolV3 via usePool hook (public RPC, no wallet needed)
 *   2. Wallet managed by RainbowKit/Wagmi (useAccount, useWalletClient)
 *   3. Context-Aware Auto-Fill:
 *      - ?action=fund_premium → hides inputs, reads premiumAmount from Vault, one-click button
 *      - ?action=provide_collateral → pre-fills amount if &amount= present in URL
 *      - ?action=withdraw → shows withdraw button directly
 *   4. Granular state buttons:
 *      - isApproving → "Aprobando USDC..."
 *      - isExecuting → "Pagando Prima..." / "Depositando..." / etc.
 *      - isSuccess → "TX confirmada" + basescan link
 *   5. Executes transactions via usePoolActions → Router or Vault
 */

import React, { useState, useMemo, useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useAccount, useWalletClient } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { usePool } from "../hooks/usePool";
import { usePoolActions } from "../hooks/usePoolActions";
import { POOL_STATUS_COLORS, CONTRACTS, CHAIN_ID } from "../lib/contracts";

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
  const [tokenMode, setTokenMode] = useState("usdc"); // "usdc" | "mpoolv3"
  const [premiumTokenMode, setPremiumTokenMode] = useState("usdc");
  const [premiumMpoolAmount, setPremiumMpoolAmount] = useState("");
  const [mpoolQuote, setMpoolQuote] = useState(null);
  const [premiumMpoolQuote, setPremiumMpoolQuote] = useState(null);

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
      if (premiumTokenMode === "usdc") {
        await actions.fundPremiumWithUSDC(poolId, pool.requiredPremium);
      } else {
        if (!premiumMpoolAmount || Number(premiumMpoolAmount) <= 0) return;
        const quote = await actions.quoteMpoolToUsdc(premiumMpoolAmount);
        const minOut = (Number(quote) * 0.97).toFixed(6); // 3% slippage
        await actions.fundPremiumWithMPOOL(poolId, premiumMpoolAmount, minOut);
      }
      refetch();
    } catch {
      // Error already captured in actions.error
    }
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
    if (!depositAmount || (tokenMode === "usdc" && Number(depositAmount) < 10)) return;
    try {
      if (tokenMode === "usdc") {
        await actions.joinPoolWithUSDC(poolId, depositAmount);
      } else {
        const quote = await actions.quoteMpoolToUsdc(depositAmount);
        const minOut = (Number(quote) * 0.97).toFixed(6);
        await actions.joinPoolWithMPOOL(poolId, depositAmount, minOut);
      }
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

  // ── Helper: check if any action is in progress ──
  const isBusy = actions.isApproving || actions.isExecuting;

  // ═══════════════════════════════════════════════════
  // Button label generators (granular state)
  // ═══════════════════════════════════════════════════

  function premiumButtonLabel() {
    if (actions.isApproving) {
      return premiumTokenMode === "usdc" ? "Aprobando USDC..." : "Aprobando MPOOLV3...";
    }
    if (actions.isExecuting) {
      return "Pagando Prima...";
    }
    if (premiumTokenMode === "usdc") {
      return `Pagar Prima ${Number(pool.requiredPremium).toLocaleString()} USDC`;
    }
    return `Swap & Pagar Prima ${premiumMpoolAmount || "0"} MPOOLV3`;
  }

  function collateralButtonLabel() {
    if (actions.isApproving) {
      return tokenMode === "usdc" ? "Aprobando USDC..." : "Aprobando MPOOLV3...";
    }
    if (actions.isExecuting) {
      return "Depositando Colateral...";
    }
    if (tokenMode === "usdc") {
      return `Depositar ${depositAmount || "0"} USDC`;
    }
    return `Swap & Depositar ${depositAmount || "0"} MPOOLV3`;
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
              PENDING: Fund Premium
              Context-Aware: ?action=fund_premium → auto-fill, no inputs
              ═══════════════════════════════════════════ */}
          {pool.status === 0 && pool.isDepositOpen && (
            <div className="action-section">
              <h3>Pagar Prima (Convertirse en Asegurado)</h3>
              <p>
                Prima requerida: <strong>{Number(pool.requiredPremium).toLocaleString()} USDC</strong>
              </p>

              {/* If deep-linked with ?action=fund_premium → auto-fill mode (no inputs) */}
              {isAutoFillPremium ? (
                <>
                  <p className="hint">
                    Monto auto-detectado desde el contrato. Tu dirección ({address?.slice(0, 6)}...
                    {address?.slice(-4)}) será el asegurado.
                  </p>
                  <button
                    onClick={handleFundPremium}
                    disabled={isBusy}
                    className="btn btn-primary"
                  >
                    {premiumButtonLabel()}
                  </button>
                </>
              ) : (
                <>
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
                        placeholder="Cantidad (MPOOLV3)"
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
                          Estimado: ~{Number(premiumMpoolQuote).toFixed(2)} USDC
                          (necesita {Number(pool.requiredPremium).toLocaleString()} USDC, 3% slippage)
                        </p>
                      )}
                    </>
                  )}

                  <p className="hint">
                    Tu dirección ({address?.slice(0, 6)}...{address?.slice(-4)}) será el asegurado.
                    Recibirás el pago de cobertura si el reclamo es aprobado.
                  </p>
                  <button
                    onClick={handleFundPremium}
                    disabled={isBusy || (premiumTokenMode === "mpoolv3" && !premiumMpoolAmount)}
                    className="btn btn-primary"
                  >
                    {premiumButtonLabel()}
                  </button>
                </>
              )}
            </div>
          )}

          {/* ═══════════════════════════════════════════
              OPEN: Provide Collateral
              Context-Aware: ?action=provide_collateral&amount=X → pre-filled
              ═══════════════════════════════════════════ */}
          {pool.status === 1 && pool.isDepositOpen && userRole !== "insured" && (
            <div className="action-section">
              <h3>Proveer Colateral</h3>

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
                placeholder={tokenMode === "usdc" ? "Cantidad (USDC, min 10)" : "Cantidad (MPOOLV3)"}
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
                  Estimado: ~{Number(mpoolQuote).toFixed(2)} USDC (3% slippage)
                </p>
              )}

              <p className="hint">
                Restante: {(Number(pool.coverageAmount) - Number(pool.totalCollateral)).toLocaleString()} USDC
              </p>

              <button
                onClick={handleJoinPool}
                disabled={
                  isBusy ||
                  !depositAmount ||
                  (tokenMode === "usdc" && Number(depositAmount) < 10)
                }
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
          {pool.status === 3 && (userRole === "provider" || userRole === "insured") && (
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
          {(pool.status === 1 || pool.status === 0) &&
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
