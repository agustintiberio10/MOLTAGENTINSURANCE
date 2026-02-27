import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import PoolPage from "./components/PoolPage";
import PoolList from "./components/PoolList";
import Header from "./components/Header";

/**
 * App — Root layout and routing.
 *
 * Routes:
 *   /               → PoolList (browse active pools)
 *   /pool/:id       → PoolPage (single pool detail + actions)
 *   /pool/:id?action=fund_premium          → deep-link: pay premium
 *   /pool/:id?action=provide_collateral    → deep-link: deposit collateral
 *   /pool/:id?action=withdraw              → deep-link: claim funds
 */
export default function App() {
  return (
    <div className="app">
      <Header />
      <main className="main-content">
        <Routes>
          <Route path="/" element={<PoolList />} />
          <Route path="/pool/:id" element={<PoolPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
