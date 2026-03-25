// Collect OSRS update impact data
// - Detects new game updates from Wiki Category:{year}_updates
// - Re-processes existing updates with incomplete timeframe data
// - Runs as GitHub Actions cron (every 4h) or manually
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const USER_AGENT = 'osrs-update-impact-tracker - github.com/LarsJ95/osrs-update-impact-tracker'
const WIKI_API = 'https://oldschool.runescape.wiki/api.php'
const PRICES_API = 'https://prices.runescape.wiki/api/v1/osrs'
const DATA_DIR = join(__dirname, '..', 'data')
const UPDATES_DIR = join(DATA_DIR, 'updates')
const INDEX_PATH = join(UPDATES_DIR, 'index.json')
const MAPPING_PATH = join(DATA_DIR, 'mapping.json')

if (!existsSync(UPDATES_DIR)) mkdirSync(UPDATES_DIR, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))

function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

async function fetchJson(url, useUA = false) {
  const headers = useUA ? { 'User-Agent': USER_AGENT } : {}
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

async function fetchSnapshot(updateTs, offset, label, baseline, mapping) {
  console.log(`  Fetching +${label} snapshot...`)
  try {
    const ts = Math.floor((updateTs + offset) / 3600) * 3600
    const snap = (await fetchJson(`${PRICES_API}/1h?timestamp=${ts}`, true)).data
    await sleep(1000)

    const movers = []
    for (const [id, base] of Object.entries(baseline)) {
      const after = snap[id]
      if (!after || !base.avgHighPrice || !base.avgLowPrice || !after.avgHighPrice || !after.avgLowPrice) continue
      const baseMid = (base.avgHighPrice + base.avgLowPrice) / 2
      const afterMid = (after.avgHighPrice + after.avgLowPrice) / 2
      if (baseMid < 10) continue
      const volume = after.highPriceVolume + after.lowPriceVolume
      if (volume < 50) continue
      const deltaAbs = afterMid - baseMid
      const deltaPct = (deltaAbs / baseMid) * 100
      if (Math.abs(deltaPct) < 2) continue
      const name = mapping[Number(id)]?.name ?? `Item ${id}`
      movers.push({
        itemId: Number(id), name,
        baselinePrice: Math.round(baseMid), price: Math.round(afterMid),
        deltaAbs: Math.round(deltaAbs),
        deltaPct: Math.round(deltaPct * 100) / 100,
        volume
      })
    }

    movers.sort((a, b) => b.deltaPct - a.deltaPct)
    const gainers = movers.filter(m => m.deltaPct > 0).slice(0, 50)
    const losers = movers.filter(m => m.deltaPct < 0).sort((a, b) => a.deltaPct - b.deltaPct).slice(0, 50)
    return [...gainers, ...losers]
  } catch (err) {
    console.warn(`  Warning: ${label} fetch failed:`, err.message)
    return null
  }
}

// Step 1: Fetch updates from Wiki
const year = new Date().getFullYear()
console.log(`Fetching updates from Category:${year}_updates...`)
const catUrl = `${WIKI_API}?action=query&list=categorymembers&cmtitle=Category:${year}_updates&cmlimit=15&cmsort=timestamp&cmdir=desc&format=json`
const catData = await fetchJson(catUrl)
const wikiUpdates = catData.query.categorymembers.filter(m => m.title.startsWith('Update:'))
console.log(`Found ${wikiUpdates.length} updates from Wiki`)

// Step 2: Load index
const index = existsSync(INDEX_PATH) ? JSON.parse(readFileSync(INDEX_PATH, 'utf-8')) : []
const existingSlugs = new Set(index.map(e => e.slug))

// Step 3: Find new updates
const newUpdates = []
for (const wu of wikiUpdates) {
  const displayName = wu.title.replace(/^Update:/, '')
  const slug = toSlug(displayName)
  if (!existingSlugs.has(slug)) {
    newUpdates.push({ displayName, slug, pageTitle: wu.title })
  }
}
console.log(`${newUpdates.length} new update(s) to add`)

// Step 4: Find existing updates with incomplete data (need re-processing)
const reprocessUpdates = []
for (const entry of index) {
  const filePath = join(UPDATES_DIR, `${entry.slug}.json`)
  if (!existsSync(filePath)) continue
  const detail = JSON.parse(readFileSync(filePath, 'utf-8'))
  const m = detail.topMovers
  const has1h = m.after1h && m.after1h.length > 0
  const has6h = m.after6h && m.after6h.length > 0
  const has24h = m.after24h && m.after24h.length > 0
  if (has1h && has6h && has24h) continue // complete

  // Only re-process if update is < 48h old (beyond that, data won't improve)
  const ageH = (Date.now() / 1000 - detail.updateTimestamp) / 3600
  if (ageH > 48) continue

  reprocessUpdates.push({ ...entry, updateTimestamp: detail.updateTimestamp, existing: detail })
}
if (reprocessUpdates.length > 0) {
  console.log(`${reprocessUpdates.length} existing update(s) need re-processing`)
}

if (newUpdates.length === 0 && reprocessUpdates.length === 0) {
  console.log('Nothing to do')
  process.exit(0)
}

// Step 5: Load mapping
let mapping = {}
if (existsSync(MAPPING_PATH)) {
  const items = JSON.parse(readFileSync(MAPPING_PATH, 'utf-8'))
  for (const item of items) mapping[item.id] = item
} else {
  console.log('Fetching mapping...')
  const items = await fetchJson(`${PRICES_API}/mapping`, true)
  writeFileSync(MAPPING_PATH, JSON.stringify(items))
  for (const item of items) mapping[item.id] = item
}

// Step 6: Process new updates
for (const update of newUpdates) {
  console.log(`\nProcessing NEW: ${update.displayName}`)

  const revUrl = `${WIKI_API}?action=query&titles=${encodeURIComponent(update.pageTitle)}&prop=revisions&rvprop=timestamp&rvdir=newer&rvlimit=1&format=json`
  const revData = await fetchJson(revUrl)
  const pages = Object.values(revData.query.pages)
  const isoTs = pages[0]?.revisions?.[0]?.timestamp
  if (!isoTs) { console.error('  No revision found, skipping'); continue }

  const dateStr = isoTs.slice(0, 10)
  const updateTs = Math.floor(new Date(isoTs).getTime() / 1000)
  const now = Math.floor(Date.now() / 1000)
  const elapsed = now - updateTs
  console.log(`  Date: ${dateStr}, elapsed: ${Math.round(elapsed / 360) / 10}h`)

  const can1h = elapsed > 2 * 3600
  const can6h = elapsed > 7 * 3600
  const can24h = elapsed > 25 * 3600
  console.log(`  Can fetch: 1h=${can1h}, 6h=${can6h}, 24h=${can24h}`)

  let topMovers = { after1h: null, after6h: null, after24h: null }

  if (can1h || can6h || can24h) {
    console.log('  Fetching baseline...')
    const baseline = (await fetchJson(`${PRICES_API}/1h?timestamp=${Math.floor((updateTs - 3600) / 3600) * 3600}`, true)).data
    await sleep(1000)

    if (can1h) topMovers.after1h = await fetchSnapshot(updateTs, 3600, '1h', baseline, mapping)
    if (can6h) topMovers.after6h = await fetchSnapshot(updateTs, 21600, '6h', baseline, mapping)
    if (can24h) topMovers.after24h = await fetchSnapshot(updateTs, 86400, '24h', baseline, mapping)
  }

  const detail = {
    title: update.displayName,
    date: dateStr,
    updateTimestamp: updateTs,
    collectedAt: new Date().toISOString(),
    topMovers
  }
  const filePath = join(UPDATES_DIR, `${update.slug}.json`)
  writeFileSync(filePath, JSON.stringify(detail, null, 2))
  console.log(`  Written: ${update.slug}.json (1h: ${topMovers.after1h?.length ?? 'null'}, 6h: ${topMovers.after6h?.length ?? 'null'}, 24h: ${topMovers.after24h?.length ?? 'null'})`)

  index.push({ date: dateStr, title: update.displayName, slug: update.slug })
}

// Step 7: Re-process incomplete updates
for (const update of reprocessUpdates) {
  console.log(`\nRe-processing: ${update.title}`)
  const detail = update.existing
  const updateTs = detail.updateTimestamp
  const now = Math.floor(Date.now() / 1000)
  const elapsed = now - updateTs

  const has1h = detail.topMovers.after1h && detail.topMovers.after1h.length > 0
  const has6h = detail.topMovers.after6h && detail.topMovers.after6h.length > 0
  const has24h = detail.topMovers.after24h && detail.topMovers.after24h.length > 0

  const need1h = !has1h && elapsed > 2 * 3600
  const need6h = !has6h && elapsed > 7 * 3600
  const need24h = !has24h && elapsed > 25 * 3600

  if (!need1h && !need6h && !need24h) {
    console.log('  Nothing ready yet, skipping')
    continue
  }

  console.log(`  Need: 1h=${need1h}, 6h=${need6h}, 24h=${need24h}`)
  console.log('  Fetching baseline...')
  const baseline = (await fetchJson(`${PRICES_API}/1h?timestamp=${Math.floor((updateTs - 3600) / 3600) * 3600}`, true)).data
  await sleep(1000)

  if (need1h) detail.topMovers.after1h = await fetchSnapshot(updateTs, 3600, '1h', baseline, mapping)
  if (need6h) detail.topMovers.after6h = await fetchSnapshot(updateTs, 21600, '6h', baseline, mapping)
  if (need24h) detail.topMovers.after24h = await fetchSnapshot(updateTs, 86400, '24h', baseline, mapping)

  detail.collectedAt = new Date().toISOString()
  const filePath = join(UPDATES_DIR, `${update.slug}.json`)
  writeFileSync(filePath, JSON.stringify(detail, null, 2))
  console.log(`  Updated: ${update.slug}.json`)
}

// Step 8: Sort index newest-first and write
index.sort((a, b) => b.date.localeCompare(a.date))
writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2))
console.log(`\nDone. Index has ${index.length} entries.`)
