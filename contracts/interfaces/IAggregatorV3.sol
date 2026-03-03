// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAggregatorV3
/// @notice Interfaz estándar de Chainlink AggregatorV3.
///         Definida manualmente para evitar dependencia externa.
///         Ref: docs.chain.link/data-feeds/api-reference
interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );

    function decimals() external view returns (uint8);

    function description() external view returns (string memory);
}
