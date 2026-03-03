const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("AutoResolver — Resolución paramétrica con Chainlink", function () {
  let resolver, mockResolver, ethFeed, btcFeed;
  let owner, anyone;

  // Constantes del test
  const ETH_PRICE = 2000_00000000n;      // $2000 con 8 decimales (formato Chainlink)
  const BTC_PRICE = 40000_00000000n;      // $40000 con 8 decimales
  const MAX_STALENESS = 3600;             // 1 hora
  const ONE_DAY = 86400;
  const ONE_HOUR = 3600;

  // TriggerType enum values
  const PRICE_BELOW = 0;
  const PRICE_ABOVE = 1;
  const PRICE_DROP_PCT = 2;
  const PRICE_RISE_PCT = 3;
  const PRICE_DIVERGENCE = 4;
  const GAS_ABOVE = 5;

  async function deployFeed(price, decimals, description) {
    const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
    const feed = await MockAggregator.deploy(price, decimals, description);
    await feed.waitForDeployment();
    return feed;
  }

  beforeEach(async function () {
    [owner, anyone] = await ethers.getSigners();

    // Deploy mocks
    const MockDisputeResolver = await ethers.getContractFactory("MockDisputeResolver");
    mockResolver = await MockDisputeResolver.deploy();
    await mockResolver.waitForDeployment();

    ethFeed = await deployFeed(ETH_PRICE, 8, "ETH/USD");
    btcFeed = await deployFeed(BTC_PRICE, 8, "BTC/USD");

    // Deploy AutoResolver
    const AutoResolver = await ethers.getContractFactory("AutoResolver");
    resolver = await AutoResolver.deploy(
      await mockResolver.getAddress(),
      MAX_STALENESS
    );
    await resolver.waitForDeployment();
  });

  // ═══════════════════════════════════════════════════════════════
  // CONSTRUCTOR
  // ═══════════════════════════════════════════════════════════════

  describe("Constructor", function () {
    it("configura disputeResolver y maxStaleness correctamente", async function () {
      expect(await resolver.disputeResolver()).to.equal(await mockResolver.getAddress());
      expect(await resolver.maxStaleness()).to.equal(MAX_STALENESS);
    });

    it("revierte con resolver address(0)", async function () {
      const AutoResolver = await ethers.getContractFactory("AutoResolver");
      await expect(
        AutoResolver.deploy(ethers.ZeroAddress, MAX_STALENESS)
      ).to.be.revertedWith("AR: invalid resolver");
    });

    it("revierte con staleness 0", async function () {
      const AutoResolver = await ethers.getContractFactory("AutoResolver");
      await expect(
        AutoResolver.deploy(await mockResolver.getAddress(), 0)
      ).to.be.revertedWith("AR: invalid staleness");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // REGISTRO DE PÓLIZAS
  // ═══════════════════════════════════════════════════════════════

  describe("registerPolicy", function () {
    it("registra una póliza correctamente y emite evento", async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      const threshold = 1800_00000000n; // $1800

      await expect(
        resolver.registerPolicy(
          1, PRICE_BELOW, await ethFeed.getAddress(), ethers.ZeroAddress,
          threshold, 0, ONE_HOUR, deadline
        )
      ).to.emit(resolver, "PolicyRegistered")
        .withArgs(1, PRICE_BELOW, threshold, ETH_PRICE);

      const policy = await resolver.getPolicy(1);
      expect(policy.chainlinkFeed).to.equal(await ethFeed.getAddress());
      expect(policy.startPrice).to.equal(ETH_PRICE);
      expect(policy.threshold).to.equal(threshold);
      expect(policy.resolved).to.be.false;
      expect(await resolver.getRegisteredPoolCount()).to.equal(1);
    });

    it("revierte si no es owner", async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      await expect(
        resolver.connect(anyone).registerPolicy(
          1, PRICE_BELOW, await ethFeed.getAddress(), ethers.ZeroAddress,
          1800_00000000n, 0, 0, deadline
        )
      ).to.be.revertedWithCustomError(resolver, "OwnableUnauthorizedAccount");
    });

    it("revierte si el pool ya está registrado", async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      await resolver.registerPolicy(
        1, PRICE_BELOW, await ethFeed.getAddress(), ethers.ZeroAddress,
        1800_00000000n, 0, 0, deadline
      );
      await expect(
        resolver.registerPolicy(
          1, PRICE_ABOVE, await ethFeed.getAddress(), ethers.ZeroAddress,
          3000_00000000n, 0, 0, deadline
        )
      ).to.be.revertedWith("AR: already registered");
    });

    it("revierte con feed address(0)", async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      await expect(
        resolver.registerPolicy(
          1, PRICE_BELOW, ethers.ZeroAddress, ethers.ZeroAddress,
          1800_00000000n, 0, 0, deadline
        )
      ).to.be.revertedWith("AR: invalid feed");
    });

    it("revierte PRICE_DIVERGENCE sin secondary feed", async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      await expect(
        resolver.registerPolicy(
          1, PRICE_DIVERGENCE, await ethFeed.getAddress(), ethers.ZeroAddress,
          500, 0, 0, deadline
        )
      ).to.be.revertedWith("AR: divergence needs secondary feed");
    });

    it("revierte con deadline en el pasado", async function () {
      const pastDeadline = (await time.latest()) - 100;
      await expect(
        resolver.registerPolicy(
          1, PRICE_BELOW, await ethFeed.getAddress(), ethers.ZeroAddress,
          1800_00000000n, 0, 0, pastDeadline
        )
      ).to.be.revertedWith("AR: deadline in past");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PRICE_BELOW — precio cae por debajo del threshold
  // ═══════════════════════════════════════════════════════════════

  describe("PRICE_BELOW trigger", function () {
    const POOL_ID = 10;
    const THRESHOLD = 1800_00000000n; // $1800

    beforeEach(async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      await resolver.registerPolicy(
        POOL_ID, PRICE_BELOW, await ethFeed.getAddress(), ethers.ZeroAddress,
        THRESHOLD, 0, 0, deadline
      );
    });

    it("resuelve claim cuando precio cae por debajo", async function () {
      // Bajar precio a $1500
      await ethFeed.setPrice(1500_00000000n);

      await expect(resolver.connect(anyone).checkAndResolve(POOL_ID))
        .to.emit(resolver, "ResolutionProposed")
        .withArgs(POOL_ID, true, "Trigger condition met: parametric threshold breached");

      // Verificar que se llamó a proposeResolution
      expect(await mockResolver.getResolutionCount()).to.equal(1);
      const [poolId, shouldPay] = await mockResolver.getResolution(0);
      expect(poolId).to.equal(POOL_ID);
      expect(shouldPay).to.be.true;

      // Verificar que se marcó como resolved
      const policy = await resolver.getPolicy(POOL_ID);
      expect(policy.resolved).to.be.true;
    });

    it("no resuelve cuando precio está por encima del threshold", async function () {
      // Precio sigue en $2000, threshold es $1800
      await resolver.connect(anyone).checkAndResolve(POOL_ID);

      // No debería haber resolución
      expect(await mockResolver.getResolutionCount()).to.equal(0);
      const policy = await resolver.getPolicy(POOL_ID);
      expect(policy.resolved).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PRICE_ABOVE — precio sube por encima del threshold
  // ═══════════════════════════════════════════════════════════════

  describe("PRICE_ABOVE trigger", function () {
    const POOL_ID = 20;
    const THRESHOLD = 2500_00000000n; // $2500

    beforeEach(async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      await resolver.registerPolicy(
        POOL_ID, PRICE_ABOVE, await ethFeed.getAddress(), ethers.ZeroAddress,
        THRESHOLD, 0, 0, deadline
      );
    });

    it("resuelve cuando precio sube por encima", async function () {
      await ethFeed.setPrice(3000_00000000n); // $3000

      await resolver.connect(anyone).checkAndResolve(POOL_ID);

      expect(await mockResolver.getResolutionCount()).to.equal(1);
      const [, shouldPay] = await mockResolver.getResolution(0);
      expect(shouldPay).to.be.true;
    });

    it("no resuelve cuando precio está por debajo", async function () {
      // $2000 < $2500 threshold
      await resolver.connect(anyone).checkAndResolve(POOL_ID);
      expect(await mockResolver.getResolutionCount()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PRICE_DROP_PCT — caída porcentual desde startPrice
  // ═══════════════════════════════════════════════════════════════

  describe("PRICE_DROP_PCT trigger", function () {
    const POOL_ID = 30;
    const THRESHOLD_BPS = 1000n; // 10% drop

    beforeEach(async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      await resolver.registerPolicy(
        POOL_ID, PRICE_DROP_PCT, await ethFeed.getAddress(), ethers.ZeroAddress,
        THRESHOLD_BPS, 0, 0, deadline
      );
    });

    it("resuelve cuando caída >= threshold%", async function () {
      // startPrice = $2000, bajamos a $1700 = 15% drop
      await ethFeed.setPrice(1700_00000000n);

      await resolver.connect(anyone).checkAndResolve(POOL_ID);

      expect(await mockResolver.getResolutionCount()).to.equal(1);
      const [, shouldPay] = await mockResolver.getResolution(0);
      expect(shouldPay).to.be.true;
    });

    it("no resuelve cuando caída < threshold%", async function () {
      // $1950 = 2.5% drop, threshold es 10%
      await ethFeed.setPrice(1950_00000000n);

      await resolver.connect(anyone).checkAndResolve(POOL_ID);
      expect(await mockResolver.getResolutionCount()).to.equal(0);
    });

    it("no resuelve cuando precio sube", async function () {
      await ethFeed.setPrice(2200_00000000n); // subió
      await resolver.connect(anyone).checkAndResolve(POOL_ID);
      expect(await mockResolver.getResolutionCount()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PRICE_RISE_PCT — subida porcentual desde startPrice
  // ═══════════════════════════════════════════════════════════════

  describe("PRICE_RISE_PCT trigger", function () {
    const POOL_ID = 40;
    const THRESHOLD_BPS = 2000n; // 20% rise

    beforeEach(async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      await resolver.registerPolicy(
        POOL_ID, PRICE_RISE_PCT, await ethFeed.getAddress(), ethers.ZeroAddress,
        THRESHOLD_BPS, 0, 0, deadline
      );
    });

    it("resuelve cuando subida >= threshold%", async function () {
      // startPrice = $2000, subimos a $2500 = 25% rise
      await ethFeed.setPrice(2500_00000000n);

      await resolver.connect(anyone).checkAndResolve(POOL_ID);
      const [, shouldPay] = await mockResolver.getResolution(0);
      expect(shouldPay).to.be.true;
    });

    it("no resuelve cuando subida < threshold%", async function () {
      await ethFeed.setPrice(2100_00000000n); // 5% rise, need 20%
      await resolver.connect(anyone).checkAndResolve(POOL_ID);
      expect(await mockResolver.getResolutionCount()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PRICE_DIVERGENCE — diferencia entre dos feeds
  // ═══════════════════════════════════════════════════════════════

  describe("PRICE_DIVERGENCE trigger", function () {
    const POOL_ID = 50;
    const THRESHOLD_BPS = 500n; // 5% divergence

    beforeEach(async function () {
      // Dos feeds de USDC/USD que deberían estar ~$1.00
      const deadline = (await time.latest()) + ONE_DAY;
      const usdcFeed1 = await deployFeed(1_00000000n, 8, "USDC/USD-1"); // $1.00
      const usdcFeed2 = await deployFeed(1_00000000n, 8, "USDC/USD-2"); // $1.00
      this.usdcFeed1 = usdcFeed1;
      this.usdcFeed2 = usdcFeed2;

      await resolver.registerPolicy(
        POOL_ID, PRICE_DIVERGENCE,
        await usdcFeed1.getAddress(),
        await usdcFeed2.getAddress(),
        THRESHOLD_BPS, 0, 0, deadline
      );
    });

    it("resuelve cuando divergencia >= threshold%", async function () {
      // Feed1 = $1.00, Feed2 = $0.90 → 11% divergencia
      await this.usdcFeed2.setPrice(90000000n); // $0.90

      await resolver.connect(anyone).checkAndResolve(POOL_ID);
      expect(await mockResolver.getResolutionCount()).to.equal(1);
      const [, shouldPay] = await mockResolver.getResolution(0);
      expect(shouldPay).to.be.true;
    });

    it("no resuelve cuando divergencia < threshold%", async function () {
      // Feed1 = $1.00, Feed2 = $0.98 → 2% < 5% threshold
      await this.usdcFeed2.setPrice(98000000n);

      await resolver.connect(anyone).checkAndResolve(POOL_ID);
      expect(await mockResolver.getResolutionCount()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // WAITING PERIOD
  // ═══════════════════════════════════════════════════════════════

  describe("Waiting period", function () {
    const POOL_ID = 60;
    const WAITING_PERIOD = ONE_HOUR;

    beforeEach(async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      await resolver.registerPolicy(
        POOL_ID, PRICE_BELOW, await ethFeed.getAddress(), ethers.ZeroAddress,
        1800_00000000n, 0, WAITING_PERIOD, deadline
      );
    });

    it("revierte si el waiting period no pasó", async function () {
      await ethFeed.setPrice(1500_00000000n);
      await expect(
        resolver.connect(anyone).checkAndResolve(POOL_ID)
      ).to.be.revertedWith("AR: waiting period active");
    });

    it("resuelve después del waiting period", async function () {
      await time.increase(WAITING_PERIOD + 1);
      // Re-set precio para actualizar updatedAt después del time.increase
      await ethFeed.setPrice(1500_00000000n);

      await resolver.connect(anyone).checkAndResolve(POOL_ID);
      expect(await mockResolver.getResolutionCount()).to.equal(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SUSTAINED PERIOD — condición debe mantenerse
  // ═══════════════════════════════════════════════════════════════

  describe("Sustained period", function () {
    const POOL_ID = 70;
    const SUSTAINED = ONE_HOUR; // 1 hora de condición sostenida

    beforeEach(async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      await resolver.registerPolicy(
        POOL_ID, PRICE_BELOW, await ethFeed.getAddress(), ethers.ZeroAddress,
        1800_00000000n, SUSTAINED, 0, deadline
      );
    });

    it("primera detección emite ConditionDetected pero no resuelve", async function () {
      await ethFeed.setPrice(1500_00000000n);

      await expect(resolver.connect(anyone).checkAndResolve(POOL_ID))
        .to.emit(resolver, "ConditionDetected");

      expect(await mockResolver.getResolutionCount()).to.equal(0);
      const policy = await resolver.getPolicy(POOL_ID);
      expect(policy.resolved).to.be.false;
      expect(policy.conditionMetAt).to.be.gt(0);
    });

    it("resuelve después del sustainedPeriod si condición persiste", async function () {
      await ethFeed.setPrice(1500_00000000n);

      // Primera detección
      await resolver.connect(anyone).checkAndResolve(POOL_ID);

      // Avanzar tiempo y refrescar feed
      await time.increase(SUSTAINED + 1);
      await ethFeed.setPrice(1500_00000000n); // mismo precio, updatedAt actualizado

      // Segunda llamada → debería resolver
      await resolver.connect(anyone).checkAndResolve(POOL_ID);
      expect(await mockResolver.getResolutionCount()).to.equal(1);
    });

    it("revierte si se llama antes de que pase sustainedPeriod", async function () {
      await ethFeed.setPrice(1500_00000000n);

      // Primera detección
      await resolver.connect(anyone).checkAndResolve(POOL_ID);

      // Llamar de nuevo sin esperar suficiente
      await time.increase(SUSTAINED / 2);
      await expect(
        resolver.connect(anyone).checkAndResolve(POOL_ID)
      ).to.be.revertedWith("AR: sustained period not met");
    });

    it("resetea conditionMetAt si la condición deja de cumplirse", async function () {
      await ethFeed.setPrice(1500_00000000n); // trigger
      await resolver.connect(anyone).checkAndResolve(POOL_ID);

      // Precio se recupera
      await ethFeed.setPrice(1900_00000000n); // > $1800 threshold
      await resolver.connect(anyone).checkAndResolve(POOL_ID);

      // conditionMetAt debería resetearse
      const policy = await resolver.getPolicy(POOL_ID);
      expect(policy.conditionMetAt).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // EXPIRACIÓN — deadline sin trigger
  // ═══════════════════════════════════════════════════════════════

  describe("Expiración sin trigger", function () {
    const POOL_ID = 80;

    beforeEach(async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      await resolver.registerPolicy(
        POOL_ID, PRICE_BELOW, await ethFeed.getAddress(), ethers.ZeroAddress,
        1800_00000000n, 0, 0, deadline
      );
    });

    it("resuelve como no-claim cuando expira sin trigger", async function () {
      // Avanzar pasado el deadline y refrescar feed (mismo precio, no triggered)
      await time.increase(ONE_DAY + 1);
      await ethFeed.setPrice(ETH_PRICE); // $2000, por encima del threshold $1800

      await resolver.connect(anyone).checkAndResolve(POOL_ID);

      expect(await mockResolver.getResolutionCount()).to.equal(1);
      const [poolId, shouldPay, reason] = await mockResolver.getResolution(0);
      expect(poolId).to.equal(POOL_ID);
      expect(shouldPay).to.be.false;
      expect(reason).to.equal("Coverage period expired without trigger");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // DOBLE RESOLUCIÓN — no resolver dos veces
  // ═══════════════════════════════════════════════════════════════

  describe("Doble resolución", function () {
    const POOL_ID = 90;

    beforeEach(async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      await resolver.registerPolicy(
        POOL_ID, PRICE_BELOW, await ethFeed.getAddress(), ethers.ZeroAddress,
        1800_00000000n, 0, 0, deadline
      );
    });

    it("revierte si se intenta resolver un pool ya resuelto", async function () {
      await ethFeed.setPrice(1500_00000000n);
      await resolver.connect(anyone).checkAndResolve(POOL_ID);

      await expect(
        resolver.connect(anyone).checkAndResolve(POOL_ID)
      ).to.be.revertedWith("AR: already resolved");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // STALE PRICE — feed desactualizado
  // ═══════════════════════════════════════════════════════════════

  describe("Stale price detection", function () {
    const POOL_ID = 100;

    beforeEach(async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      await resolver.registerPolicy(
        POOL_ID, PRICE_BELOW, await ethFeed.getAddress(), ethers.ZeroAddress,
        1800_00000000n, 0, 0, deadline
      );
    });

    it("revierte cuando el price feed está stale", async function () {
      // Poner updatedAt en el pasado (2 horas atrás, staleness es 1 hora)
      const staleTime = (await time.latest()) - MAX_STALENESS - 100;
      await ethFeed.setPriceWithTimestamp(1500_00000000n, staleTime);

      await expect(
        resolver.connect(anyone).checkAndResolve(POOL_ID)
      ).to.be.revertedWith("AR: stale price feed");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // BATCH CHECK — múltiples pools
  // ═══════════════════════════════════════════════════════════════

  describe("batchCheck", function () {
    beforeEach(async function () {
      const deadline = (await time.latest()) + ONE_DAY;

      // Pool 1: PRICE_BELOW $1800
      await resolver.registerPolicy(
        1, PRICE_BELOW, await ethFeed.getAddress(), ethers.ZeroAddress,
        1800_00000000n, 0, 0, deadline
      );

      // Pool 2: PRICE_ABOVE $2500
      await resolver.registerPolicy(
        2, PRICE_ABOVE, await ethFeed.getAddress(), ethers.ZeroAddress,
        2500_00000000n, 0, 0, deadline
      );

      // Pool 3: PRICE_DROP_PCT 15%
      await resolver.registerPolicy(
        3, PRICE_DROP_PCT, await ethFeed.getAddress(), ethers.ZeroAddress,
        1500n, 0, 0, deadline
      );
    });

    it("resuelve múltiples pools en una transacción", async function () {
      // ETH baja a $1500 → Pool 1 (BELOW $1800) y Pool 3 (25% drop) se activan
      await ethFeed.setPrice(1500_00000000n);

      await resolver.connect(anyone).batchCheck([1, 2, 3]);

      // Pool 1 y 3 deberían resolver, Pool 2 no (ABOVE $2500, precio es $1500)
      expect(await mockResolver.getResolutionCount()).to.equal(2);
    });

    it("no revierte si un pool falla (aislamiento)", async function () {
      await ethFeed.setPrice(1500_00000000n);

      // Resolver pool 1 primero para que falle en batch (ya resuelto)
      await resolver.connect(anyone).checkAndResolve(1);
      expect(await mockResolver.getResolutionCount()).to.equal(1);

      // Batch con pool 1 (ya resuelto, falla) y pool 3 (25% drop, resuelve)
      await resolver.connect(anyone).batchCheck([1, 3]);

      // Solo pool 3 debería resolverse adicionalmente
      expect(await mockResolver.getResolutionCount()).to.equal(2);
    });

    it("funciona con un pool no registrado sin revertir", async function () {
      await ethFeed.setPrice(1500_00000000n);

      // Pool 999 no existe → falla silenciosamente en batch
      await resolver.connect(anyone).batchCheck([999, 1]);

      expect(await mockResolver.getResolutionCount()).to.equal(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ADMIN — setMaxStaleness, setDisputeResolver
  // ═══════════════════════════════════════════════════════════════

  describe("Admin functions", function () {
    it("owner puede actualizar maxStaleness", async function () {
      await expect(resolver.setMaxStaleness(7200))
        .to.emit(resolver, "MaxStalenessUpdated")
        .withArgs(7200);
      expect(await resolver.maxStaleness()).to.equal(7200);
    });

    it("non-owner no puede actualizar maxStaleness", async function () {
      await expect(
        resolver.connect(anyone).setMaxStaleness(7200)
      ).to.be.revertedWithCustomError(resolver, "OwnableUnauthorizedAccount");
    });

    it("owner puede actualizar disputeResolver", async function () {
      const MockDisputeResolver = await ethers.getContractFactory("MockDisputeResolver");
      const newResolver = await MockDisputeResolver.deploy();
      await newResolver.waitForDeployment();

      await expect(resolver.setDisputeResolver(await newResolver.getAddress()))
        .to.emit(resolver, "DisputeResolverUpdated")
        .withArgs(await newResolver.getAddress());
    });

    it("revierte con address(0) para resolver", async function () {
      await expect(
        resolver.setDisputeResolver(ethers.ZeroAddress)
      ).to.be.revertedWith("AR: invalid resolver");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // VIEWS
  // ═══════════════════════════════════════════════════════════════

  describe("View functions", function () {
    it("getRegisteredPoolIds retorna la lista correcta", async function () {
      const deadline = (await time.latest()) + ONE_DAY;

      await resolver.registerPolicy(
        5, PRICE_BELOW, await ethFeed.getAddress(), ethers.ZeroAddress,
        1800_00000000n, 0, 0, deadline
      );
      await resolver.registerPolicy(
        10, PRICE_ABOVE, await ethFeed.getAddress(), ethers.ZeroAddress,
        3000_00000000n, 0, 0, deadline
      );

      const ids = await resolver.getRegisteredPoolIds();
      expect(ids.length).to.equal(2);
      expect(ids[0]).to.equal(5);
      expect(ids[1]).to.equal(10);
    });

    it("checkAndResolve revierte para pool no registrado", async function () {
      await expect(
        resolver.checkAndResolve(999)
      ).to.be.revertedWith("AR: not registered");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // GAS_ABOVE — gas price supera threshold
  // ═══════════════════════════════════════════════════════════════

  describe("GAS_ABOVE trigger", function () {
    it("no resuelve con gas price normal (Hardhat default)", async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      // Threshold muy bajo para que Hardhat's default gasprice lo triggeree
      // Hardhat usa gasprice ~1-8 gwei. Threshold = 1 wei → siempre triggered.
      // Threshold = 1e18 wei → nunca triggered en test.
      const highThreshold = ethers.parseEther("1"); // 1 ETH en wei — nunca triggered

      await resolver.registerPolicy(
        200, GAS_ABOVE, await ethFeed.getAddress(), ethers.ZeroAddress,
        highThreshold, 0, 0, deadline
      );

      await resolver.connect(anyone).checkAndResolve(200);
      expect(await mockResolver.getResolutionCount()).to.equal(0);
    });
  });
});
