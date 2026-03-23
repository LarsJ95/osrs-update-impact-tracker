import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────
const USER_AGENT =
  "osrs-update-impact-tracker - github.com/LarsJ95/osrs-update-impact-tracker";
const WIKI_API = "https://oldschool.runescape.wiki/api.php";
const PRICES_API = "https://prices.runescape.wiki/api/v1/osrs";
const DATA_DIR = join(__dirname, "..", "data");
const UPDATES_DIR = join(DATA_DIR, "updates");
const INDEX_PATH = join(UPDATES_DIR, "index.json");
const MAPPING_PATH = join(DATA_DIR, "mapping.json");

// ─── Types ───────────────────────────────────────────────────────────
interface IndexEntry {
  date: string;
  title: string;
  slug: string;
}

interface WikiCategoryMember {
  pageid: number;
  ns: number;
  title: string;
}

interface PriceDataPoint {
  avgHighPrice: number | null;
  highPriceVolume: number;
  avgLowPrice: number | null;
  lowPriceVolume: number;
}

interface MappingItem {
  id: number;
  name: string;
  examine: string;
  members: boolean;
  lowalch: number | null;
  highalch: number | null;
  limit: number | null;
  value: number;
  icon: string;
}

interface ItemMover {
  itemId: number;
  name: string;
  baselinePrice: number;
  price: number;
  deltaAbs: number;
  deltaPct: number;
  volume: number;
}

interface UpdateFile {
  title: string;
  date: string;
  updateTimestamp: number;
  collectedAt: string;
  topMovers: {
    after1h: ItemMover[] | null;
    after6h: ItemMover[] | null;
    after24h: ItemMover[] | null;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Check if a UTC date falls within UK BST (last Sunday of March to last Sunday of October). */
function isUkBst(date: Date): boolean {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0-indexed

  // BST runs from last Sunday of March (month 2) to last Sunday of October (month 9)
  if (month < 2 || month > 9) return false;
  if (month > 2 && month < 9) return true;

  // March: find last Sunday
  if (month === 2) {
    const lastDay = new Date(Date.UTC(year, 3, 0)); // last day of March
    const lastSunday = lastDay.getUTCDate() - lastDay.getUTCDay();
    // BST starts at 01:00 UTC on that Sunday
    const bstStart = Date.UTC(year, 2, lastSunday, 1, 0, 0);
    return date.getTime() >= bstStart;
  }

  // October: find last Sunday
  const lastDay = new Date(Date.UTC(year, 10, 0)); // last day of October
  const lastSunday = lastDay.getUTCDate() - lastDay.getUTCDay();
  // BST ends at 01:00 UTC on that Sunday
  const bstEnd = Date.UTC(year, 9, lastSunday, 1, 0, 0);
  return date.getTime() < bstEnd;
}

/** Build Unix timestamp (seconds) for 11:30 UK time on a given date string (YYYY-MM-DD). */
function updateTimestampForDate(dateStr: string): number {
  const date = new Date(dateStr + "T11:30:00Z");
  // If this date is in BST, 11:30 UK = 10:30 UTC
  // If GMT, 11:30 UK = 11:30 UTC
  if (isUkBst(date)) {
    date.setUTCHours(10, 30, 0, 0);
  } else {
    date.setUTCHours(11, 30, 0, 0);
  }
  return Math.floor(date.getTime() / 1000);
}

async function fetchJson<T>(url: string, useUserAgent = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (useUserAgent) {
    headers["User-Agent"] = USER_AGENT;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json() as Promise<T>;
}

// ─── Step A: Fetch recent updates from Wiki ──────────────────────────
async function fetchRecentUpdates(): Promise<WikiCategoryMember[]> {
  const url = `${WIKI_API}?action=query&list=categorymembers&cmtitle=Category:Game_updates&cmlimit=10&cmsort=timestamp&cmdir=desc&format=json`;
  const data = await fetchJson<{
    query: { categorymembers: WikiCategoryMember[] };
  }>(url);
  return data.query.categorymembers;
}

// ─── Step B: Get update date from revision timestamp ─────────────────
async function getUpdateDate(pageTitle: string): Promise<string> {
  const url = `${WIKI_API}?action=query&titles=${encodeURIComponent(pageTitle)}&prop=revisions&rvprop=timestamp&format=json`;
  const data = await fetchJson<{
    query: { pages: Record<string, { revisions?: { timestamp: string }[] }> };
  }>(url);

  const pages = Object.values(data.query.pages);
  const rev = pages[0]?.revisions?.[0];
  if (!rev) throw new Error(`No revision found for ${pageTitle}`);

  // Extract date part (YYYY-MM-DD)
  return rev.timestamp.slice(0, 10);
}

// ─── Step C: Fetch price snapshots ───────────────────────────────────
async function fetchPriceSnapshot(
  timestamp: number
): Promise<Record<string, PriceDataPoint>> {
  // API requires timestamp divisible by 3600 — floor to nearest hour
  const aligned = Math.floor(timestamp / 3600) * 3600;
  const url = `${PRICES_API}/1h?timestamp=${aligned}`;
  const data = await fetchJson<{ data: Record<string, PriceDataPoint> }>(
    url,
    true
  );
  return data.data;
}

// ─── Mapping ─────────────────────────────────────────────────────────
async function getMapping(): Promise<Record<number, MappingItem>> {
  let needsRefresh = true;

  if (existsSync(MAPPING_PATH)) {
    const stat = statSync(MAPPING_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    if (ageMs < sevenDays) {
      needsRefresh = false;
    }
  }

  if (needsRefresh) {
    console.log("Refreshing item mapping...");
    const items = await fetchJson<MappingItem[]>(
      `${PRICES_API}/mapping`,
      true
    );
    writeFileSync(MAPPING_PATH, JSON.stringify(items));
    const map: Record<number, MappingItem> = {};
    for (const item of items) map[item.id] = item;
    return map;
  }

  const items: MappingItem[] = JSON.parse(readFileSync(MAPPING_PATH, "utf-8"));
  const map: Record<number, MappingItem> = {};
  for (const item of items) map[item.id] = item;
  return map;
}

// ─── Step D + E: Calculate impact and filter noise ───────────────────
function calculateMovers(
  baseline: Record<string, PriceDataPoint>,
  after: Record<string, PriceDataPoint> | null,
  mapping: Record<number, MappingItem>
): ItemMover[] | null {
  if (!after) return null;

  const movers: ItemMover[] = [];

  for (const [itemId, baseData] of Object.entries(baseline)) {
    const afterData = after[itemId];
    if (!afterData) continue;

    // Calculate mid prices
    if (
      baseData.avgHighPrice == null ||
      baseData.avgLowPrice == null ||
      afterData.avgHighPrice == null ||
      afterData.avgLowPrice == null
    )
      continue;

    const baseMid = (baseData.avgHighPrice + baseData.avgLowPrice) / 2;
    const afterMid = (afterData.avgHighPrice + afterData.avgLowPrice) / 2;

    // Filter: baseline must be >= 10 GP
    if (baseMid < 10) continue;

    // Volume filter: need at least 50 trades
    const volume =
      afterData.highPriceVolume + afterData.lowPriceVolume;
    if (volume < 50) continue;

    const deltaAbs = afterMid - baseMid;
    const deltaPct = (deltaAbs / baseMid) * 100;

    const id = Number(itemId);
    const name = mapping[id]?.name ?? `Item ${id}`;

    movers.push({
      itemId: id,
      name,
      baselinePrice: Math.round(baseMid),
      price: Math.round(afterMid),
      deltaAbs: Math.round(deltaAbs),
      deltaPct: Math.round(deltaPct * 100) / 100,
      volume,
    });
  }

  return movers;
}

function filterNoise(
  after1h: ItemMover[] | null,
  after6h: ItemMover[] | null,
  after24h: ItemMover[] | null
): {
  after1h: ItemMover[] | null;
  after6h: ItemMover[] | null;
  after24h: ItemMover[] | null;
} {
  // Collect item IDs that have < 2% absolute delta on ALL available timeframes
  const noisyItems = new Set<number>();

  // Build a set of all item IDs
  const allIds = new Set<number>();
  for (const list of [after1h, after6h, after24h]) {
    if (list) for (const m of list) allIds.add(m.itemId);
  }

  for (const id of allIds) {
    const get = (list: ItemMover[] | null) =>
      list?.find((m) => m.itemId === id);
    const m1 = get(after1h);
    const m6 = get(after6h);
    const m24 = get(after24h);

    // Check: less than 2% absolute delta on ALL available timeframes
    const available = [m1, m6, m24].filter(Boolean) as ItemMover[];
    if (available.length === 0) continue;

    const allBelow2 = available.every((m) => Math.abs(m.deltaPct) < 2);
    if (allBelow2) noisyItems.add(id);
  }

  const filter = (list: ItemMover[] | null) =>
    list ? list.filter((m) => !noisyItems.has(m.itemId)) : null;

  return {
    after1h: filter(after1h),
    after6h: filter(after6h),
    after24h: filter(after24h),
  };
}

function topMovers(list: ItemMover[] | null): ItemMover[] | null {
  if (!list) return null;
  // Sort by deltaPct descending, take top 50 gainers
  const sorted = [...list].sort((a, b) => b.deltaPct - a.deltaPct);
  const gainers = sorted.filter((m) => m.deltaPct > 0).slice(0, 50);
  const losers = sorted.filter((m) => m.deltaPct < 0).slice(-50).reverse();
  // losers sorted by deltaPct ascending (biggest losers first)
  losers.sort((a, b) => a.deltaPct - b.deltaPct);
  return [...gainers, ...losers];
}

// ─── Main ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // Ensure directories exist
  if (!existsSync(UPDATES_DIR)) mkdirSync(UPDATES_DIR, { recursive: true });

  // Load index
  const index: IndexEntry[] = existsSync(INDEX_PATH)
    ? JSON.parse(readFileSync(INDEX_PATH, "utf-8"))
    : [];
  const existingSlugs = new Set(index.map((e) => e.slug));

  // Step A: fetch recent updates
  console.log("Fetching recent game updates from Wiki...");
  const wikiUpdates = await fetchRecentUpdates();
  console.log(`Found ${wikiUpdates.length} recent updates`);

  // Determine which are new
  const newUpdates: { title: string; displayName: string; slug: string; pageTitle: string }[] = [];
  for (const wu of wikiUpdates) {
    const displayName = wu.title.replace(/^Update:/, "");
    const slug = toSlug(displayName);
    if (!existingSlugs.has(slug)) {
      newUpdates.push({
        title: wu.title,
        displayName,
        slug,
        pageTitle: wu.title,
      });
    }
  }

  if (newUpdates.length === 0) {
    console.log("No new updates to process");
    return;
  }

  console.log(`${newUpdates.length} new update(s) to process`);

  // Load mapping
  const mapping = await getMapping();

  // Process each new update
  for (const update of newUpdates) {
    console.log(`\nProcessing: ${update.displayName}`);

    // Step B: get date
    let dateStr: string;
    try {
      dateStr = await getUpdateDate(update.pageTitle);
    } catch (err) {
      console.error(`  Failed to get date for ${update.pageTitle}:`, err);
      process.exit(1);
      return; // unreachable but satisfies TS control flow
    }
    console.log(`  Date: ${dateStr}`);

    const updateTimestamp = updateTimestampForDate(dateStr);
    console.log(`  Update timestamp: ${updateTimestamp} (${new Date(updateTimestamp * 1000).toISOString()})`);

    // Step C: fetch price data (4 calls with 1s delay between each)
    console.log("  Fetching baseline (1h before update)...");
    let baseline: Record<string, PriceDataPoint>;
    try {
      baseline = await fetchPriceSnapshot(updateTimestamp - 3600);
    } catch (err) {
      console.error("  Failed to fetch baseline price data:", err);
      process.exit(1);
      return; // unreachable but satisfies TS control flow
    }

    await sleep(1000);

    console.log("  Fetching +1h snapshot...");
    let snap1h: Record<string, PriceDataPoint> | null = null;
    try {
      snap1h = await fetchPriceSnapshot(updateTimestamp + 3600);
    } catch (err) {
      console.warn("  Warning: Failed to fetch +1h data:", err);
    }

    await sleep(1000);

    console.log("  Fetching +6h snapshot...");
    let snap6h: Record<string, PriceDataPoint> | null = null;
    try {
      snap6h = await fetchPriceSnapshot(updateTimestamp + 21600);
    } catch (err) {
      console.warn("  Warning: Failed to fetch +6h data:", err);
    }

    await sleep(1000);

    console.log("  Fetching +24h snapshot...");
    let snap24h: Record<string, PriceDataPoint> | null = null;
    try {
      snap24h = await fetchPriceSnapshot(updateTimestamp + 86400);
    } catch (err) {
      console.warn("  Warning: Failed to fetch +24h data:", err);
    }

    // Step D: calculate impact
    let after1h = calculateMovers(baseline, snap1h, mapping);
    let after6h = calculateMovers(baseline, snap6h, mapping);
    let after24h = calculateMovers(baseline, snap24h, mapping);

    // Step E: filter noise
    const filtered = filterNoise(after1h, after6h, after24h);
    after1h = filtered.after1h;
    after6h = filtered.after6h;
    after24h = filtered.after24h;

    // Step F: top 50 gainers + top 50 losers
    const result: UpdateFile = {
      title: update.displayName,
      date: dateStr,
      updateTimestamp,
      collectedAt: new Date().toISOString(),
      topMovers: {
        after1h: topMovers(after1h),
        after6h: topMovers(after6h),
        after24h: topMovers(after24h),
      },
    };

    // Write update file
    const filePath = join(UPDATES_DIR, `${update.slug}.json`);
    writeFileSync(filePath, JSON.stringify(result, null, 2));
    console.log(`  Written: ${filePath}`);

    // Count items
    const count1h = result.topMovers.after1h?.length ?? 0;
    const count6h = result.topMovers.after6h?.length ?? 0;
    const count24h = result.topMovers.after24h?.length ?? 0;
    console.log(`  Top movers: ${count1h} (1h), ${count6h} (6h), ${count24h} (24h)`);

    // Update index
    index.push({
      date: dateStr,
      title: update.displayName,
      slug: update.slug,
    });
  }

  // Write updated index
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
  console.log(`\nIndex updated with ${newUpdates.length} new entry/entries`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
