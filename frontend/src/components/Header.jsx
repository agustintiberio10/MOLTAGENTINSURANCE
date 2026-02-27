/**
 * Header — Top navigation bar with RainbowKit wallet connection.
 */

import React from "react";
import { Link } from "react-router-dom";
import { ConnectButton } from "@rainbow-me/rainbowkit";

export default function Header() {
  return (
    <header className="header">
      <div className="header-left">
        <Link to="/" className="logo">
          MutualPool
        </Link>
        <span className="network-badge">Base</span>
      </div>

      <ConnectButton
        chainStatus="icon"
        showBalance={false}
        accountStatus="address"
      />
    </header>
  );
}
