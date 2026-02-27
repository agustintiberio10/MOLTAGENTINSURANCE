import React from "react";
import { Link } from "react-router-dom";
import { useWallet } from "../hooks/useWallet";

/**
 * Header — Top navigation bar with wallet connection.
 */
export default function Header() {
  const { address, connected, isBase, connect, switchToBase } = useWallet();

  return (
    <header className="header">
      <div className="header-left">
        <Link to="/" className="logo">
          MutualPool
        </Link>
        <span className="network-badge">Base</span>
      </div>

      <div className="header-right">
        {!connected ? (
          <button onClick={connect} className="btn btn-connect">
            Connect Wallet
          </button>
        ) : !isBase ? (
          <button onClick={switchToBase} className="btn btn-warning">
            Switch to Base
          </button>
        ) : (
          <div className="wallet-info">
            <span className="wallet-dot" />
            <span className="wallet-address">
              {address?.slice(0, 6)}...{address?.slice(-4)}
            </span>
          </div>
        )}
      </div>
    </header>
  );
}
