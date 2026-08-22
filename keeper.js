/**
 * NinjaNex Keeper — runs every 10 minutes via GitHub Actions
 * 1. Reads the live floor price of the target collection (OpenSea data on Ethereum mainnet)
 * 2. Calls updateFloorPrice when on-chain price drifts > 0.5%
 * 3. Calls executePayout when the pool reaches the floor price; the winner is paid in ETH instantly
 *
 * First payout rule (V4):
 *   When the pool first reaches the floor price, the first executePayout call only records
 *   poolFullSince without paying out; after FIRST_PAYOUT_DELAY (2h) the next call executes:
 *   winner receives the floor price, all remainder goes to the creator. Normal logic after that.
 *
 * Environment variables (GitHub Secrets):
 *   PRIVATE_KEY  - keeper wallet private key (gas only, no funds)
 *   RPC_URL      - Robinhood chain RPC
 *   NFT_API      - Alchemy Ethereum NFT API (reads target collection floor price)
 *   VAULT        - NinjaNexVault proxy contract address
 *   TARGET       - price reference collection (Bored Ape Yacht Club)
 */
const { ethers } = require("ethers");
const crypto = require("crypto");

const PRIVATE_KEY = (process.env.PRIVATE_KEY || "").trim();
const RPC_URL  = process.env.RPC_URL;
const NFT_API  = process.env.NFT_API;
const VAULT    = process.env.VAULT    || "0x4FC1FF668f42e1b9Bb31AC70Ce969648b79C9988";
const TARGET   = process.env.TARGET   || "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";

const FIRST_PAYOUT_DELAY = 2 * 3600; // must match contract FIRST_PAYOUT_DELAY

const ABI = [
  "function floorPrice() view returns (uint256)",
  "function prizePool() view returns (uint256)",
  "function shouldFill() view returns (bool)",
  "function firstPayoutDone() view returns (bool)",
  "function poolFullSince() view returns (uint256)",
  "function updateFloorPrice(uint256 newPrice) external",
  "function executePayout(uint256 randomSeed) external"
];

async function fetchFloorEth() {
  const res = await fetch(`${NFT_API}/getFloorPrice?contractAddress=${TARGET}`);
  const j = await res.json();
  const p = j && j.openSea && j.openSea.floorPrice;
  if (!p || !(p > 0)) throw new Error("floor price unavailable");
  return p;
}

function randomSeed() {
  return BigInt("0x" + crypto.randomBytes(32).toString("hex"));
}

async function tryPayout(vault) {
  for (let i = 0; i < 5; i++) {
    try {
      const tx = await vault.executePayout(randomSeed());
      await tx.wait();
      console.log(`PAYOUT EXECUTED (tx ${tx.hash})`);
      return true;
    } catch (e) {
      const msg = e.shortMessage || e.message || "";
      console.log(`payout attempt ${i + 1} failed: ${msg}`);
      if (msg.includes("WAIT")) return false;
    }
  }
  console.log("payout failed after 5 attempts, will retry next run");
  return false;
}

async function main() {
  if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");
  if (!RPC_URL) throw new Error("RPC_URL missing (set as GitHub Actions secret)");
  if (!NFT_API) throw new Error("NFT_API missing (set as GitHub Actions secret)");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const vault = new ethers.Contract(VAULT, ABI, wallet);

  const floorEth = await fetchFloorEth();
  const newFloor = ethers.parseEther(floorEth.toFixed(6));
  const [onchainFloor, pool, fill, firstDone, fullSince] = await Promise.all([
    vault.floorPrice(), vault.prizePool(), vault.shouldFill(),
    vault.firstPayoutDone(), vault.poolFullSince()
  ]);
  console.log(`live floor: ${floorEth} ETH | on-chain: ${ethers.formatEther(onchainFloor)} | pool: ${ethers.formatEther(pool)} | shouldFill: ${fill} | firstPayoutDone: ${firstDone}`);

  // only feed the price when drift > 0.5%, saves gas
  const drift = onchainFloor === 0n ? 100 : Math.abs(Number(newFloor - onchainFloor) / Number(onchainFloor)) * 100;
  if (drift > 0.5 || (fill && onchainFloor !== newFloor)) {
    const tx = await vault.updateFloorPrice(newFloor);
    await tx.wait();
    console.log(`floor updated -> ${floorEth} ETH (tx ${tx.hash})`);
  } else {
    console.log(`drift ${drift.toFixed(2)}% <= 0.5%, skip update`);
  }

  if (!(await vault.shouldFill())) return;

  // ===== first payout: two phases =====
  if (!firstDone) {
    if (fullSince === 0n) {
      const tx = await vault.executePayout(randomSeed());
      await tx.wait();
      console.log(`pool full — first payout marked at ${new Date().toISOString()}, pays out after 2h (tx ${tx.hash})`);
      return;
    }
    const unlockAt = Number(fullSince) + FIRST_PAYOUT_DELAY;
    const now = Math.floor(Date.now() / 1000);
    if (now < unlockAt) {
      console.log(`first payout pending — ${Math.ceil((unlockAt - now) / 60)} min remaining`);
      return;
    }
    console.log("first payout delay elapsed — executing FIRST payout (winner gets floor, remainder to creator)");
    await tryPayout(vault);
    return;
  }

  // ===== regular payout =====
  await tryPayout(vault);
}

main().catch(e => { console.error(e); process.exit(1); });
