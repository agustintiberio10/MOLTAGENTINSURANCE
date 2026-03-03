// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockDisputeResolver
/// @notice Mock que registra llamadas a proposeResolution() para verificar en tests.
contract MockDisputeResolver {
    struct Resolution {
        uint256 poolId;
        bool shouldPay;
        string reason;
    }

    Resolution[] public resolutions;

    function proposeResolution(
        uint256 poolId,
        bool shouldPay,
        string calldata reason
    ) external {
        resolutions.push(Resolution(poolId, shouldPay, reason));
    }

    function getResolutionCount() external view returns (uint256) {
        return resolutions.length;
    }

    function getResolution(uint256 index) external view returns (
        uint256 poolId,
        bool shouldPay,
        string memory reason
    ) {
        Resolution storage r = resolutions[index];
        return (r.poolId, r.shouldPay, r.reason);
    }
}
