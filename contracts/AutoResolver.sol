// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IAggregatorV3.sol";
import "./interfaces/IDisputeResolver.sol";

/**
 * @title AutoResolver
 * @author MutualBot Insurance Protocol
 * @notice Resuelve claims de seguros paramétricos usando Chainlink price feeds.
 *         Reemplaza el oracle bot LLM con verificación on-chain determinística.
 *
 * @dev Flujo:
 *   1. Owner registra una póliza con registerPolicy() → guarda trigger + startPrice
 *   2. Cualquiera llama checkAndResolve(poolId) → lee Chainlink, evalúa condición
 *   3. Si el trigger se cumple → llama DisputeResolver.proposeResolution(poolId, true, reason)
 *   4. Si expiró sin trigger → llama proposeResolution(poolId, false, reason)
 *
 *   Para triggers con sustainedPeriod > 0:
 *   - Primera llamada detecta la condición → guarda conditionMetAt
 *   - Segunda llamada después de sustainedPeriod → si sigue activa, resuelve
 *   - Si la condición deja de cumplirse → resetea conditionMetAt
 *
 * CHAINLINK PRICE FEEDS EN BASE (mainnet):
 *   ETH/USD:  0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70
 *   BTC/USD:  0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F
 *   USDC/USD: 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B
 *   DAI/USD:  0x591e79239a7d679378eC8c847e5038150364C78F
 *   USDT/USD: 0xf19d560eB8d2ADf07BD6D13ed03e1D11215721F9
 */
contract AutoResolver is Ownable, ReentrancyGuard {

    // ══════════════════════════════════════════════════════════════
    // TIPOS
    // ══════════════════════════════════════════════════════════════

    /// @notice Tipos de trigger paramétrico soportados.
    enum TriggerType {
        PRICE_BELOW,       // precio actual < threshold
        PRICE_ABOVE,       // precio actual > threshold
        PRICE_DROP_PCT,    // caída porcentual desde startPrice > threshold (en bps)
        PRICE_RISE_PCT,    // subida porcentual desde startPrice > threshold (en bps)
        PRICE_DIVERGENCE,  // diferencia entre dos feeds > threshold% (en bps)
        GAS_ABOVE          // gas price L2 > threshold (en wei)
    }

    /// @notice Registro de póliza paramétrica por poolId.
    struct PolicyTrigger {
        TriggerType triggerType;
        address chainlinkFeed;     // feed principal de Chainlink
        address secondaryFeed;     // solo para PRICE_DIVERGENCE (address(0) en otros casos)
        int256 threshold;          // precio absoluto (8 decimales) o porcentaje en bps (100 = 1%)
        uint256 sustainedPeriod;   // segundos que la condición debe mantenerse (0 = inmediato)
        int256 startPrice;         // precio al momento de registrar la póliza
        uint256 activatedAt;       // timestamp de cuándo se activó
        uint256 waitingPeriod;     // segundos de espera antes de que la cobertura sea efectiva
        uint256 deadline;          // deadline del pool (para resolución por expiración)
        bool resolved;             // flag para no resolver dos veces
        uint256 conditionMetAt;    // timestamp de primera detección de condición (sustained)
    }

    // ══════════════════════════════════════════════════════════════
    // ESTADO
    // ══════════════════════════════════════════════════════════════

    /// @notice Contrato DisputeResolver que recibe las resoluciones.
    IDisputeResolver public disputeResolver;

    /// @notice Máximo de segundos sin actualización del feed antes de considerar stale.
    uint256 public maxStaleness;

    /// @dev poolId → configuración del trigger paramétrico
    mapping(uint256 => PolicyTrigger) public policies;

    /// @notice Lista de todos los poolIds registrados.
    uint256[] public registeredPoolIds;

    // ══════════════════════════════════════════════════════════════
    // EVENTOS
    // ══════════════════════════════════════════════════════════════

    event PolicyRegistered(
        uint256 indexed poolId,
        TriggerType triggerType,
        int256 threshold,
        int256 startPrice
    );

    event ConditionDetected(
        uint256 indexed poolId,
        int256 currentPrice,
        uint256 sustainedUntil
    );

    event ResolutionProposed(
        uint256 indexed poolId,
        bool triggered,
        string reason
    );

    event PolicyCancelled(uint256 indexed poolId);
    event PolicyUpdated(uint256 indexed poolId);
    event MaxStalenessUpdated(uint256 newMaxStaleness);
    event DisputeResolverUpdated(address newResolver);

    // ══════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ══════════════════════════════════════════════════════════════

    /// @param _disputeResolver Dirección del DisputeResolver en Base.
    /// @param _maxStaleness    Segundos máximos de antigüedad del price feed (ej: 3600 = 1h).
    constructor(
        address _disputeResolver,
        uint256 _maxStaleness
    ) Ownable(msg.sender) {
        require(_disputeResolver != address(0), "AR: invalid resolver");
        require(_maxStaleness > 0, "AR: invalid staleness");
        disputeResolver = IDisputeResolver(_disputeResolver);
        maxStaleness = _maxStaleness;
    }

    // ══════════════════════════════════════════════════════════════
    // REGISTRO DE PÓLIZAS (solo owner)
    // ══════════════════════════════════════════════════════════════

    /// @notice Registra un pool con su trigger paramétrico. Lee Chainlink para obtener startPrice.
    /// @param poolId          ID del pool en MutualLumina.
    /// @param triggerType     Tipo de condición paramétrica.
    /// @param chainlinkFeed   Dirección del price feed de Chainlink en Base.
    /// @param secondaryFeed   Segundo feed (solo PRICE_DIVERGENCE, address(0) para otros).
    /// @param threshold       Valor del trigger (precio absoluto en feed decimals, o bps para PCT).
    /// @param sustainedPeriod Segundos que la condición debe mantenerse (0 = resolución inmediata).
    /// @param waitingPeriod   Segundos de espera antes de que se pueda evaluar el trigger.
    /// @param deadline        Timestamp límite del pool (para resolución por expiración).
    function registerPolicy(
        uint256 poolId,
        TriggerType triggerType,
        address chainlinkFeed,
        address secondaryFeed,
        int256 threshold,
        uint256 sustainedPeriod,
        uint256 waitingPeriod,
        uint256 deadline
    ) external onlyOwner {
        require(policies[poolId].chainlinkFeed == address(0), "AR: already registered");
        require(chainlinkFeed != address(0), "AR: invalid feed");
        require(deadline > block.timestamp, "AR: deadline in past");

        if (triggerType == TriggerType.PRICE_DIVERGENCE) {
            require(secondaryFeed != address(0), "AR: divergence needs secondary feed");
        }

        // Leer precio actual de Chainlink como startPrice
        int256 startPrice = _getLatestPrice(chainlinkFeed);

        policies[poolId] = PolicyTrigger({
            triggerType: triggerType,
            chainlinkFeed: chainlinkFeed,
            secondaryFeed: secondaryFeed,
            threshold: threshold,
            sustainedPeriod: sustainedPeriod,
            startPrice: startPrice,
            activatedAt: block.timestamp,
            waitingPeriod: waitingPeriod,
            deadline: deadline,
            resolved: false,
            conditionMetAt: 0
        });

        registeredPoolIds.push(poolId);

        emit PolicyRegistered(poolId, triggerType, threshold, startPrice);
    }

    // ══════════════════════════════════════════════════════════════
    // RESOLUCIÓN (público — cualquiera puede triggerear)
    // ══════════════════════════════════════════════════════════════

    /// @notice Evalúa el trigger de un pool y propone resolución si corresponde.
    ///         Callable por cualquiera — la descentralización del trigger es intencional.
    function checkAndResolve(uint256 poolId) external nonReentrant {
        _checkAndResolve(poolId);
    }

    /// @notice Evalúa múltiples pools en una sola transacción.
    ///         Fallos individuales no revierten el batch completo.
    function batchCheck(uint256[] calldata poolIds) external nonReentrant {
        for (uint256 i = 0; i < poolIds.length; i++) {
            // try/catch con llamada externa para aislar fallos
            try this.checkAndResolveBatchItem(poolIds[i]) {} catch {}
        }
    }

    /// @dev Wrapper externo para batchCheck — try/catch requiere llamada externa.
    ///      Solo callable por el propio contrato.
    function checkAndResolveBatchItem(uint256 poolId) external {
        require(msg.sender == address(this), "AR: internal only");
        _checkAndResolve(poolId);
    }

    /// @dev Lógica interna de evaluación y resolución.
    function _checkAndResolve(uint256 poolId) internal {
        PolicyTrigger storage policy = policies[poolId];
        require(policy.chainlinkFeed != address(0), "AR: not registered");
        require(!policy.resolved, "AR: already resolved");
        require(
            block.timestamp >= policy.activatedAt + policy.waitingPeriod,
            "AR: waiting period active"
        );

        // Leer precio actual del feed principal
        int256 currentPrice = _getLatestPrice(policy.chainlinkFeed);
        bool triggered = _evaluateTrigger(policy, currentPrice);

        if (triggered) {
            // ── Lógica de sustainedPeriod ──
            if (policy.sustainedPeriod > 0) {
                if (policy.conditionMetAt == 0) {
                    // Primera detección — registrar timestamp, NO resolver aún
                    policy.conditionMetAt = block.timestamp;
                    emit ConditionDetected(
                        poolId,
                        currentPrice,
                        block.timestamp + policy.sustainedPeriod
                    );
                    return; // Salir sin resolver — hay que esperar sustainedPeriod
                }
                // Verificar que pasó el sustainedPeriod completo
                require(
                    block.timestamp >= policy.conditionMetAt + policy.sustainedPeriod,
                    "AR: sustained period not met"
                );
            }

            // ── Trigger confirmado → resolver como claim aprobado ──
            policy.resolved = true;
            string memory reason = "Trigger condition met: parametric threshold breached";
            disputeResolver.proposeResolution(poolId, true, reason);
            emit ResolutionProposed(poolId, true, reason);

        } else {
            // Condición no cumplida — resetear detección previa si existía
            if (policy.conditionMetAt != 0) {
                policy.conditionMetAt = 0;
            }

            // Si pasó el deadline sin trigger → resolver como sin claim
            if (block.timestamp >= policy.deadline) {
                policy.resolved = true;
                string memory reason = "Coverage period expired without trigger";
                disputeResolver.proposeResolution(poolId, false, reason);
                emit ResolutionProposed(poolId, false, reason);
            }
            // Si no expiró y no triggered → no hacer nada, se puede llamar después
        }
    }

    // ══════════════════════════════════════════════════════════════
    // EVALUACIÓN DE TRIGGERS
    // ══════════════════════════════════════════════════════════════

    /// @dev Evalúa si la condición paramétrica se cumple dado el precio actual.
    function _evaluateTrigger(
        PolicyTrigger storage policy,
        int256 currentPrice
    ) internal view returns (bool) {
        TriggerType t = policy.triggerType;

        if (t == TriggerType.PRICE_BELOW) {
            return currentPrice < policy.threshold;
        }

        if (t == TriggerType.PRICE_ABOVE) {
            return currentPrice > policy.threshold;
        }

        if (t == TriggerType.PRICE_DROP_PCT) {
            // threshold en bps: 100 = 1%, 1000 = 10%
            // Fórmula: (startPrice - currentPrice) * 10000 / startPrice >= threshold
            require(policy.startPrice > 0, "AR: startPrice must be positive");
            if (currentPrice >= policy.startPrice) return false;
            int256 dropBps = ((policy.startPrice - currentPrice) * 10000) / policy.startPrice;
            return dropBps >= policy.threshold;
        }

        if (t == TriggerType.PRICE_RISE_PCT) {
            require(policy.startPrice > 0, "AR: startPrice must be positive");
            if (currentPrice <= policy.startPrice) return false;
            int256 riseBps = ((currentPrice - policy.startPrice) * 10000) / policy.startPrice;
            return riseBps >= policy.threshold;
        }

        if (t == TriggerType.PRICE_DIVERGENCE) {
            // Comparar dos feeds — la diferencia porcentual debe superar threshold (bps)
            int256 secondaryPrice = _getLatestPrice(policy.secondaryFeed);
            require(currentPrice > 0 && secondaryPrice > 0, "AR: prices must be positive");
            int256 diff;
            if (currentPrice > secondaryPrice) {
                diff = ((currentPrice - secondaryPrice) * 10000) / secondaryPrice;
            } else {
                diff = ((secondaryPrice - currentPrice) * 10000) / currentPrice;
            }
            return diff >= policy.threshold;
        }

        if (t == TriggerType.GAS_ABOVE) {
            // LIMITACIÓN: En Base L2, tx.gasprice solo retorna el gas price de la L2
            // execution layer, no incluye el L1 data fee (blob fee). El valor puede ser
            // muy bajo (~0.001 gwei) y no refleja el costo real de la transacción.
            // Para producción se debería usar un oracle de gas dedicado (ej: Chainlink
            // Gas Price Feed o un oracle custom) que reporte el costo total L1+L2.
            return int256(uint256(tx.gasprice)) > policy.threshold;
        }

        return false;
    }

    // ══════════════════════════════════════════════════════════════
    // LECTURA DE CHAINLINK
    // ══════════════════════════════════════════════════════════════

    /// @dev Lee el último precio del feed de Chainlink con validación de staleness.
    function _getLatestPrice(address feed) internal view returns (int256) {
        (
            ,
            int256 price,
            ,
            uint256 updatedAt,
        ) = IAggregatorV3(feed).latestRoundData();

        require(price > 0, "AR: invalid price from feed");
        require(
            block.timestamp - updatedAt <= maxStaleness,
            "AR: stale price feed"
        );

        return price;
    }

    // ══════════════════════════════════════════════════════════════
    // VIEWS
    // ══════════════════════════════════════════════════════════════

    /// @notice Retorna la configuración completa de una póliza.
    function getPolicy(uint256 poolId) external view returns (PolicyTrigger memory) {
        return policies[poolId];
    }

    /// @notice Cantidad de pools registrados.
    function getRegisteredPoolCount() external view returns (uint256) {
        return registeredPoolIds.length;
    }

    /// @notice Retorna todos los poolIds registrados.
    function getRegisteredPoolIds() external view returns (uint256[] memory) {
        return registeredPoolIds;
    }

    // ══════════════════════════════════════════════════════════════
    // ADMIN
    // ══════════════════════════════════════════════════════════════

    /// @notice Cancela una póliza sin llamar a DisputeResolver.
    ///         Útil para corregir registros erróneos antes de que se resuelvan.
    function cancelPolicy(uint256 poolId) external onlyOwner {
        PolicyTrigger storage policy = policies[poolId];
        require(policy.chainlinkFeed != address(0), "AR: not registered");
        require(!policy.resolved, "AR: already resolved");
        policy.resolved = true;
        emit PolicyCancelled(poolId);
    }

    /// @notice Actualiza parámetros seguros de una póliza no resuelta.
    ///         No permite cambiar triggerType, feeds ni startPrice para evitar manipulación.
    function updatePolicy(
        uint256 poolId,
        int256 threshold,
        uint256 sustainedPeriod,
        uint256 waitingPeriod,
        uint256 deadline
    ) external onlyOwner {
        PolicyTrigger storage policy = policies[poolId];
        require(policy.chainlinkFeed != address(0), "AR: not registered");
        require(!policy.resolved, "AR: already resolved");
        require(deadline > block.timestamp, "AR: deadline in past");

        policy.threshold = threshold;
        policy.sustainedPeriod = sustainedPeriod;
        policy.waitingPeriod = waitingPeriod;
        policy.deadline = deadline;
        // Resetear detección previa ya que los parámetros cambiaron
        policy.conditionMetAt = 0;

        emit PolicyUpdated(poolId);
    }

    /// @notice Actualiza el tiempo máximo de antigüedad aceptable del price feed.
    function setMaxStaleness(uint256 _maxStaleness) external onlyOwner {
        require(_maxStaleness > 0, "AR: invalid staleness");
        maxStaleness = _maxStaleness;
        emit MaxStalenessUpdated(_maxStaleness);
    }

    /// @notice Actualiza la dirección del DisputeResolver.
    function setDisputeResolver(address _resolver) external onlyOwner {
        require(_resolver != address(0), "AR: invalid resolver");
        disputeResolver = IDisputeResolver(_resolver);
        emit DisputeResolverUpdated(_resolver);
    }
}
