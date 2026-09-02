/**
 * NinjaNex keeper — feeds the QUOTRONS floor price on-chain and executes draws.
 *
 * Setup:
 *   1) npm install ethers
 *   2) export KEEPER_PRIVATE_KEY=0x...   (the keeper wallet: 0x4ac21aff93f2728c4c27bd2c756816bc761da0ea)
 *   3) node keeper.js
 *
 * What it does every INTERVAL_SEC seconds:
 *   - reads the live QUOTRON/WETH price (DexScreener, keyless) and calls updateFloorPrice()
 *     when it moved more than MIN_CHANGE_PCT (skipped if the move looks like bad data)
 *   - when the prize pool covers the floor, calls executePayout() — the contract
 *     enforces the 2h first-draw delay itself, so calling early is harmless
 */
const { ethers } = require("ethers");

const CONFIG = {
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  contract: "0x4FC1FF668f42e1b9Bb31AC70Ce969648b79C9988",
  chainId: 4663,
  intervalSec: 300,          // check every 5 minutes
  minChangePct: 0.5,         // only push a new floor if it moved >= 0.5%
  maxJumpPct: 50,            // ignore API readings more than 50% away from on-chain (bad-data guard)
  // QUOTRONS: 1 liquid $QUOTRON token = 1 machine (NFT) — token price in WETH IS the floor
  dexscreenerApi: "https://api.dexscreener.com/latest/dex/tokens/0x5a86828Efd322bfb16d93cFeD16EE9BC14940D7F", // keyless
};

const ABI = [
  "function keeper() view returns (address)",
  "function floorPrice() view returns (uint256)",
  "function prizePool() view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "function shouldFill() view returns (bool)",
  "function firstPayoutDone() view returns (bool)",
  "function poolFullSince() view returns (uint256)",
  "function paused() view returns (bool)",
  "function updateFloorPrice(uint256 newPrice) external",
  "function executePayout(uint256 randomSeed) external",
];

const log = (...a) => console.log(new Date().toISOString(), ...a);

// source: DexScreener canonical QUOTRON/WETH pool (keyless, live)
async function fetchFloorEth() {
  // 1) OpenSea listing floor — the number users see on the marketplace (free key: OPENSEA_API_KEY env)
  const osKey = (process.env.OPENSEA_API_KEY || "3281328017194170a56c2fa3833c1eaf").trim();
  if (osKey) {
    try {
      const res = await fetch("https://api.opensea.io/api/v2/collections/quotrons404/stats",
        { headers: { "X-API-KEY": osKey, "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error("opensea HTTP " + res.status);
      const j = await res.json();
      const v = Number(j && j.total && j.total.floor_price);
      if (v && isFinite(v) && v > 0) return v;
      throw new Error("opensea returned no floor");
    } catch (e) {
      log("opensea feed failed (" + e.message + ") — falling back to dexscreener pool price");
    }
  }
  // 2) DexScreener QUOTRON/WETH pool price — keyless fallback
  const res = await fetch(CONFIG.dexscreenerApi, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("dexscreener HTTP " + res.status);
  const j = await res.json();
  // canonical QUOTRON/WETH market on Robinhood Chain, deepest liquidity wins
  const pairs = ((j && j.pairs) || []).filter(p =>
    p.chainId === "robinhood" && p.quoteToken && p.quoteToken.symbol === "WETH" && Number(p.priceNative) > 0);
  pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
  if (!pairs.length) throw new Error("dexscreener returned no WETH pair");
  return Number(pairs[0].priceNative);
}

async function tick(contract, wallet) {
  if (await contract.paused()) { log("contract paused — skipping"); return; }

  // 1) floor price feed
  try {
    let live = await fetchFloorEth();
    if (process.env.FORCE_FLOOR_ETH) { live = Number(process.env.FORCE_FLOOR_ETH); log("FORCE_FLOOR_ETH override: " + live); }
    const onchain = await contract.floorPrice();
    const onchainEth = Number(ethers.formatEther(onchain));
    const diffPct = onchainEth > 0 ? Math.abs(live - onchainEth) / onchainEth * 100 : 100;
    if (diffPct >= CONFIG.minChangePct) {
      if (diffPct > CONFIG.maxJumpPct) {
        log(`floor jump ${onchainEth} -> ${live} ETH (${diffPct.toFixed(1)}%) exceeds guard — skipped`);
      } else {
        const wei = ethers.parseEther(live.toFixed(6));
        const tx = await contract.updateFloorPrice(wei);
        log(`updateFloorPrice ${onchainEth} -> ${live} ETH, tx ${tx.hash}`);
        await tx.wait();
        log("floor confirmed on-chain");
      }
    } else {
      log(`floor ok: on-chain ${onchainEth} ETH vs live ${live} ETH (${diffPct.toFixed(2)}%)`);
    }
  } catch (e) {
    log("floor feed failed:", e.shortMessage || e.message);
  }

  // 2) draw execution
  try {
    const [fill, staked, firstDone, fullSince] = await Promise.all([
      contract.shouldFill(), contract.totalStaked(), contract.firstPayoutDone(), contract.poolFullSince(),
    ]);
    if (!fill || staked === 0n) return;
    if (!firstDone && fullSince === 0n) {
      // first call only arms the 2h countdown (contract returns without drawing)
      const tx = await contract.executePayout(ethers.toBigInt(ethers.randomBytes(32)));
      log("pool full — armed first-draw countdown, tx", tx.hash);
      await tx.wait();
      return;
    }
    const tx = await contract.executePayout(ethers.toBigInt(ethers.randomBytes(32)));
    log("executePayout sent, tx", tx.hash);
    const rc = await tx.wait();
    log(rc.status === 1 ? "DRAW EXECUTED" : "draw tx reverted");
  } catch (e) {
    const m = e.shortMessage || e.message || "";
    if (m.includes("WAIT")) log("first draw: 2h delay still running");
    else log("payout attempt failed:", m);
  }
}

async function main() {
  const key = (process.env.KEEPER_PRIVATE_KEY || process.env.PRIVATE_KEY || "").trim();
  if (!key) { console.error("set KEEPER_PRIVATE_KEY (or PRIVATE_KEY) in repo secrets first"); process.exit(1); }
  const provider = new ethers.JsonRpcProvider(CONFIG.rpc, CONFIG.chainId, { staticNetwork: true });
  const wallet = new ethers.Wallet(key, provider);
  const contract = new ethers.Contract(CONFIG.contract, ABI, wallet);

  const keeper = await contract.keeper();
  if (keeper.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error(`this key is ${wallet.address} but the contract keeper is ${keeper} — updateFloorPrice/executePayout would revert`);
    process.exit(1);
  }
  log(`keeper ${wallet.address} | balance ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH`);

  const loop = async () => { try { await tick(contract, wallet); } catch (e) { log("tick error:", e.message); } };
  await loop();
  if (process.env.GITHUB_ACTIONS) return; // Actions runs one tick per scheduled invocation
  setInterval(loop, CONFIG.intervalSec * 1000);
}

main();
