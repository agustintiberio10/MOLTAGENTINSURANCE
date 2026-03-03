// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockAggregatorV3
/// @notice Mock del price feed de Chainlink para tests.
///         Permite setear precio y updatedAt manualmente.
contract MockAggregatorV3 {
    int256 public price;
    uint256 public updatedAt;
    uint8 public decimals;
    string public description;

    constructor(int256 _price, uint8 _decimals, string memory _description) {
        price = _price;
        updatedAt = block.timestamp;
        decimals = _decimals;
        description = _description;
    }

    function setPrice(int256 _price) external {
        price = _price;
        updatedAt = block.timestamp;
    }

    function setPriceWithTimestamp(int256 _price, uint256 _updatedAt) external {
        price = _price;
        updatedAt = _updatedAt;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 _updatedAt,
            uint80 answeredInRound
        )
    {
        return (1, price, updatedAt, updatedAt, 1);
    }
}
