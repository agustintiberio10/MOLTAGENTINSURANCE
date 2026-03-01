const { TappdClient } = (() => { try { return require("@phala/dstack-sdk"); } catch { return {}; } })();
const hardenedHttpsAgent = (() => { try { return require("@phala/dstack-sdk/net").hardenedHttpsAgent; } catch { return null; } })();

let _teeClient = null;

function getTeeClient() {
  if (_teeClient) return _teeClient;
  if (!TappdClient) return null;
  const endpoint = process.env.DSTACK_SIMULATOR_ENDPOINT || undefined;
  _teeClient = new TappdClient(endpoint);
  console.log(endpoint ? `[TEE] Simulator: ${endpoint}` : "[TEE] Hardware TEE daemon");
  return _teeClient;
}

async function deriveWalletKey(path = "/lumina/oracle/wallet", subject = "v1") {
  const client = getTeeClient();
  if (!client) {
    const fallback = process.env.AGENT_PRIVATE_KEY;
    if (fallback) { console.warn("[TEE] SDK unavailable — using AGENT_PRIVATE_KEY fallback"); return fallback; }
    throw new Error("[TEE] No wallet source: install @phala/dstack-sdk or set AGENT_PRIVATE_KEY");
  }
  console.log(`[TEE] Deriving wallet: path="${path}", subject="${subject}"`);
  const result = await client.deriveKey(path, subject);
  return "0x" + Buffer.from(result.asUint8Array(32)).toString("hex");
}

async function generateAttestation(data) {
  const client = getTeeClient();
  if (!client) return null;
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  try {
    const q = await client.tdxQuote(payload);
    return { quote: q.quote, timestamp: Date.now(), payload, isSimulated: !!process.env.DSTACK_SIMULATOR_ENDPOINT };
  } catch (err) { console.error(`[TEE] Attestation failed: ${err.message}`); return null; }
}

async function teeFetch(url, options = {}) {
  if (!url || !url.startsWith("http")) throw new Error(`[TEE] Invalid URL: ${url}`);
  const timeout = options.timeout || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const opts = { method: options.method || "GET", signal: controller.signal, headers: { "User-Agent": "MutualLumina-TEE-Oracle/2.0", Accept: "application/json,text/html", ...(options.headers || {}) } };
  if (options.body) { opts.body = options.body; opts.headers["Content-Type"] = opts.headers["Content-Type"] || "application/json"; }
  if (hardenedHttpsAgent && url.startsWith("https")) opts.agent = hardenedHttpsAgent();
  try {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (!text || !text.trim()) throw new Error("Empty response");
    return text;
  } catch (err) {
    throw new Error(err.name === "AbortError" ? `[TEE] Timeout: ${url}` : `[TEE] Fetch: ${err.message}`);
  } finally { clearTimeout(timer); }
}

async function teeFetchPost(url, body, options = {}) {
  return teeFetch(url, { ...options, method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
}

function getTeeStatus() {
  return { sdkInstalled: !!TappdClient, hardenedHttpsAvailable: !!hardenedHttpsAgent, simulatorMode: !!process.env.DSTACK_SIMULATOR_ENDPOINT };
}

module.exports = { getTeeClient, deriveWalletKey, generateAttestation, teeFetch, teeFetchPost, getTeeStatus };
