// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IDisputeResolver
/// @notice Interfaz del contrato DisputeResolver desplegado en Base.
///         Actúa como intermediario entre AutoResolver y MutualLumina.
interface IDisputeResolver {
    /// @notice Propone una resolución para un pool de seguro.
    /// @param poolId   ID del pool en MutualLumina.
    /// @param shouldPay  true = claim aprobado (pagar al asegurado), false = sin claim.
    /// @param reason   Motivo de la resolución (para auditoría on-chain).
    function proposeResolution(
        uint256 poolId,
        bool shouldPay,
        string calldata reason
    ) external;
}
