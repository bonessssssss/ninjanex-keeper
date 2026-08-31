/**
 * NinjaNex keeper — feeds the BAYC floor price on-chain and executes draws.
 *
 * Setup:
 *   1) npm install ethers
 *   2) export KEEPER_PRIVATE_KEY=0x...   (the keeper wallet: 0x4ac21aff93f2728c4c27bd2c756816bc761da0ea)
 *   3) node keeper.js
 *
 * What it does every INTERVAL_SEC seconds:
 *   - reads the live BAYC floor (CoinGecko, keyless) and calls updateFloorPrice()
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
  blurApi: "https://core-api.prod.blur.io/v1/collections/0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d", // keyless, high precision
  coingeckoApi: "https://api.coingecko.com/api/v3/nfts/bored-ape-yacht-club", // keyless, coarse (2-3 decimals)
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

// source chain: Blur (keyless, ~10 decimals) -> CoinGecko (keyless, coarse fallback)
async function fetchFloorEth() {
  try {
    const res = await fetch(CONFIG.blurApi, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error("blur HTTP " + res.status);
    const j = await res.json();
    const v = Number(j && j.collection && j.collection.floorPrice && j.collection.floorPrice.amount);
    if (v && isFinite(v) && v > 0) return v;
    throw new Error("blur returned no floor");
  } catch (e) {
    log("blur feed failed (" + e.message + ") — falling back to coingecko");
  }
  const res = await fetch(CONFIG.coingeckoApi, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("coingecko HTTP " + res.status);
  const j = await res.json();
  const v = Number(j && j.floor_price && j.floor_price.native_currency);
  if (!v || !isFinite(v) || v <= 0) throw new Error("coingecko returned no price");
  return v;
}

async function tick(contract, wallet) {
  if (await contract.paused()) { log("contract paused — skipping"); return; }

  // 1) floor price feed
  try {
    const live = await fetchFloorEth();
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
