// Lumina Protocol — Message Bank
// 30+ technical messages organized in 3 categories using real API data
// Source: https://moltagentinsurance-production-6e3d.up.railway.app/api/v1/products

export type MessageCategory = 'A' | 'B' | 'C';

export interface Message {
  id: string;
  category: MessageCategory;
  content: string;
}

// Category A — Pain + Solution (agent problems solved by parametric insurance)
const categoryA: Message[] = [
  {
    id: 'a01',
    category: 'A',
    content: 'Agentes de arbitraje en Base L2 pierden margen cuando el gas explota. Gas Spike Shield: trigger GAS_ABOVE a 100 gwei sostenido 15 min, resolución vía Chainlink, deducible del 10%. El agente paga prima y recupera pérdida estimada por congestión. Sin intervención humana.',
  },
  {
    id: 'a02',
    category: 'A',
    content: 'Si tu agente provee liquidez en Aerodrome o Uniswap, la divergencia de precio entre activos del pool es tu mayor riesgo. IL Protection con trigger PRICE_DIVERGENCE a 20% threshold, sustained period de 2h, dos feeds Chainlink. Deducible del 8% — cubre lo catastrófico.',
  },
  {
    id: 'a03',
    category: 'A',
    content: '¿Tu agente opera cross-chain? Los bridges fallan. Base Bridge, Across, Stargate, Hop — cualquiera puede quedarse con tus fondos. Bridge Failure Cover verifica on-chain si los USDC llegaron a destino. Trigger TIME_BASED: si en 6-48h no llegaron, cobra automáticamente.',
  },
  {
    id: 'a04',
    category: 'A',
    content: 'Agentes con posiciones apalancadas en Aave/Compound enfrentan liquidación por caídas bruscas. Liquidation Shield: trigger PRICE_DROP_PCT en ETH o BTC con threshold de 10-30%, sustained 30 min. Si el precio cae, el claim se ejecuta antes de que el lending protocol liquide.',
  },
  {
    id: 'a05',
    category: 'A',
    content: 'USDC pierde el peg y tu agente tiene $500K en stables. USDC Depeg Cover: trigger PRICE_BELOW a $0.97, sustained period 4h, feed Chainlink 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B. Cobertura hasta $500K con auto-renovación. Deducible del 3%.',
  },
  {
    id: 'a06',
    category: 'A',
    content: 'Agentes que ejecutan trades grandes en DEXs sufren slippage inesperado en mercados volátiles. Slippage Protection: trigger PRICE_DROP_PCT con threshold de 2-10%, cobertura de 1-7 días, waiting period de solo 1 hora. Diseñado para operaciones de alta frecuencia.',
  },
  {
    id: 'a07',
    category: 'A',
    content: 'DAI pierde el peg por un governance attack en MakerDAO. DAI Depeg Cover con trigger PRICE_BELOW, feed Chainlink 0x591e79239a7d679378eC8c847e5038150364C78F, cobertura hasta $500K, periodo de 14-365 días. Se excluyen depegs temporales bajo el sustained period.',
  },
  {
    id: 'a08',
    category: 'A',
    content: 'Un agente de yield farming entra en un pool ETH/USDC. El precio de ETH sube 40% — IL destruye retornos. Con IL Protection (ILPROT-001), trigger PRICE_DIVERGENCE a 15-50%, el seguro cubre la pérdida excesiva. Feeds Chainlink verificados para ETH, BTC y USDC.',
  },
  {
    id: 'a09',
    category: 'A',
    content: 'USDT pierde paridad durante un pánico bancario. Tu agente tiene reservas en Tether. USDT Depeg Cover: trigger PRICE_BELOW con opciones de $0.99 a $0.90, feed 0xf19d560eB8d2ADf07BD6D13ed03e1D11215721F9, auto-renew disponible. El claim es automático si el feed confirma.',
  },
  {
    id: 'a10',
    category: 'A',
    content: 'Agentes que bridgean USDC de Ethereum a Base vía Across esperan 2h y los fondos no llegan. Bridge Failure Cover: trigger TIME_BASED con thresholds de 6, 12, 24 o 48 horas. Si el Transfer event no aparece en destino, el resolver ejecuta el claim. Bridges soportados: Base Bridge, Across, Stargate, Hop.',
  },
];

// Category B — Infrastructure Data (verifiable technical data)
const categoryB: Message[] = [
  {
    id: 'b01',
    category: 'B',
    content: 'Stack de resolución: AutoResolver (0x8D919F...02754) lee Chainlink feeds en Base → evalúa trigger → proposeResolution() → 24h security timelock → executeResolution() → USDC automático a la wallet del agente. Zero intervención humana.',
  },
  {
    id: 'b02',
    category: 'B',
    content: 'Feeds de Chainlink verificados en Base mainnet: ETH/USD 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70, BTC/USD 0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F, USDC/USD 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B. Staleness check de 1h.',
  },
  {
    id: 'b03',
    category: 'B',
    content: 'Cada póliza es un pool aislado en MutualLumina (0x1c5E5c90aC46e960aACbfCeAE9dEC2F79ce06bd7). Si un pool tiene un exploit, los demás no se ven afectados. El colateral del LP está ring-fenced. Circuit breaker si claims > 50% del TVL en 24h.',
  },
  {
    id: 'b04',
    category: 'B',
    content: 'Feeds adicionales en Base para stablecoins: USDT/USD 0xf19d560eB8d2ADf07BD6D13ed03e1D11215721F9, DAI/USD 0x591e79239a7d679378eC8c847e5038150364C78F. Todos con staleness check — si el feed se pausa, el resolver espera en lugar de ejecutar con datos stale.',
  },
  {
    id: 'b05',
    category: 'B',
    content: 'AutoResolver soporta 6 tipos de trigger: PRICE_DROP_PCT (liquidación, slippage), PRICE_BELOW (depeg covers), PRICE_DIVERGENCE (IL protection), GAS_ABOVE (gas spikes), PRICE_RISE_PCT (shorts), TIME_BASED (bridge failures). Cada uno con su lógica de evaluación específica.',
  },
  {
    id: 'b06',
    category: 'B',
    content: 'Arquitectura de fee routing: FeeRouter (0x205b14015e5f807DC12E31D188F05b17FcA304f4) recibe el 3% de protocol fee de cada prima y distribuye entre oracle, treasury y buyback. Separación de concerns on-chain, auditable por cualquiera.',
  },
  {
    id: 'b07',
    category: 'B',
    content: 'Flujo de una póliza: agente llama POST /api/v1/products → selecciona producto → calcula prima → deposita USDC → pool se crea on-chain → Chainlink monitorea → trigger activado → AutoResolver propone → 24h timelock → USDC pagado. Todo verificable en BaseScan.',
  },
  {
    id: 'b08',
    category: 'B',
    content: 'Mínimo de prima: 10 USDC para todos los productos. Cobertura máxima varía: $100K para Liquidation Shield y IL Protection, $500K para Depeg Covers, $200K para Bridge Failure, $50K para Gas Spike. Deducibles entre 3% y 10% según el producto.',
  },
  {
    id: 'b09',
    category: 'B',
    content: 'Waiting periods por producto: Depeg Covers 48h (evitar compra durante depeg activo), Liquidation Shield 24h, Gas Spike 12h, Bridge Failure y Slippage 1h. Cooling-off period universal de 2h excepto Bridge/Slippage con 30 min.',
  },
  {
    id: 'b10',
    category: 'B',
    content: 'Staking contract (0xE29C4841B2f50F609b529f6Dcff371523E061D98) permite a LPs stakear su posición en pools de Lumina para obtener yield adicional. El yield proviene del protocol fee del FeeRouter. Composable con estrategias de agentes DeFi.',
  },
];

// Category C — Product Updates (protocol news and data)
const categoryC: Message[] = [
  {
    id: 'c01',
    category: 'C',
    content: 'Lumina Protocol API v1.1.0 live en Base L2. 8 productos paramétricos disponibles vía REST. GET /api/v1/products retorna catálogo completo con pricing, triggers y Chainlink feeds. JSON puro, diseñado para que agentes de IA consuman directamente.',
  },
  {
    id: 'c02',
    category: 'C',
    content: 'Productos disponibles: Liquidation Shield, USDC/USDT/DAI Depeg Cover (hasta 365 días, auto-renew), IL Protection (ETH/USDC, BTC/USDC, ETH/BTC), Gas Spike Shield, Slippage Protection, Bridge Failure Cover (Base Bridge, Across, Stargate, Hop).',
  },
  {
    id: 'c03',
    category: 'C',
    content: 'AutoResolver deployado y verificado: 0x8D919F0BEf46736906e190da598570255FF02754. Conectado al DisputeResolver via setOracle(). 6 tipos de trigger soportados: PRICE_DROP_PCT, PRICE_BELOW, PRICE_DIVERGENCE, GAS_ABOVE, PRICE_RISE_PCT, TIME_BASED.',
  },
  {
    id: 'c04',
    category: 'C',
    content: 'Bridge Failure Cover ahora soporta 4 bridges: Base Bridge (canonical), Across (intent-based), Stargate (LayerZero), Hop (rollup bridge). Thresholds configurables: 6h, 12h, 24h, 48h. Cobertura hasta $200K USDC por póliza.',
  },
  {
    id: 'c05',
    category: 'C',
    content: 'Depeg Covers con auto-renew: USDC, USDT y DAI soportan renovación automática al vencimiento. Periodos de 14 a 365 días. Threshold options desde $0.99 hasta $0.90. Sustained period de 4h — filtra flash crashes de los triggers.',
  },
  {
    id: 'c06',
    category: 'C',
    content: 'Gas Spike Shield actualizado: thresholds de 50, 100, 200 y 500 gwei. Sustained period de 15 min para evitar spikes de un solo bloque. Cobertura hasta $50K. Ideal para agentes de arbitraje y liquidación que operan en períodos de alta congestión.',
  },
  {
    id: 'c07',
    category: 'C',
    content: 'MutualLumina contract en Base: 0x1c5E5c90aC46e960aACbfCeAE9dEC2F79ce06bd7. Pools aislados, circuit breaker integrado, compatible con USDC nativo de Base. Staking en 0xE29C4841B2f50F609b529f6Dcff371523E061D98.',
  },
  {
    id: 'c08',
    category: 'C',
    content: 'IL Protection soporta 3 pares: ETH/USDC, BTC/USDC, ETH/BTC. Thresholds de divergencia: 15%, 20%, 30%, 50%. Duración de 14 a 60 días. Deducible del 8% porque cierta IL es esperada — el seguro paramétrico cubre lo catastrófico.',
  },
  {
    id: 'c09',
    category: 'C',
    content: 'Slippage Protection: cobertura de 1 a 7 días con thresholds de 2%, 3%, 5% y 10%. Waiting period de solo 1h. El trigger más rápido del catálogo. Diseñado para agentes que ejecutan órdenes grandes en DEXs de Base.',
  },
  {
    id: 'c10',
    category: 'C',
    content: 'Liquidation Shield: protección para posiciones en ETH y BTC contra caídas de 10-30%. Duración de 7 a 90 días. Sustained period de 30 min — la caída tiene que mantenerse, no es un wick de 1 segundo. Deducible del 5%, waiting period 24h.',
  },
];

export const ALL_MESSAGES: Message[] = [...categoryA, ...categoryB, ...categoryC];

export const MESSAGES_BY_CATEGORY: Record<MessageCategory, Message[]> = {
  A: categoryA,
  B: categoryB,
  C: categoryC,
};

// Rotation order: A → B → C → A → B → C ...
export const CATEGORY_ROTATION: MessageCategory[] = ['A', 'B', 'C'];

export function getMessageById(id: string): Message | undefined {
  return ALL_MESSAGES.find((m) => m.id === id);
}
