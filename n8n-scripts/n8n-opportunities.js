// n8n FUNCTION node (NOT Function Item)
// INPUT: $input.all() — one of the items must contain keys:
//   oneToFive, fiveToTen, tenToFifteen, fifteenToTwenty
//   (your sample outer array with one object is also supported)
// OUTPUT: one item with
//   { json: { texts: {oneToFive..fifteenToTwenty}, counts: {..} } }
// Each texts.<bucket> is a Discord-friendly bullet list with clickable links
// and NO preview cards (we use <url>).

function computeTimeLeftFromEndDate(endDate) {
  try {
    const end = new Date(endDate);
    const now = new Date();
    let ms = Math.max(0, end - now);
    const h = Math.floor(ms / 3600000);  ms -= h * 3600000;
    const m = Math.floor(ms / 60000);    ms -= m * 60000;
    const s = Math.floor(ms / 1000);
    const hh = String(h).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch { return ""; }
}

function zipOutcomes(outcomes, prices) {
  const o = Array.isArray(outcomes) ? outcomes : [];
  const p = Array.isArray(prices) ? prices : [];
  const n = Math.max(o.length, p.length);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const label = o[i] ?? `O${i+1}`;
    const price = (p[i] !== undefined && p[i] !== null) ? String(p[i]) : "?";
    parts.push(`${label}:${price}`);
  }
  return parts.join(" | ");
}

// Escape Discord markdown so questions don't accidentally italic/bold
function escMD(s) {
  return String(s ?? "").replace(/[\\*_`~|]/g, m => `\\${m}`);
}

// Wrap URL in <...> so it's clickable but no preview card
function clickableNoPreview(u) {
  if (!u) return "";
  return `<${u}>`;
}

function formatVolume(vol) {
  if (vol === null || vol === undefined) return "";
  if (vol >= 1_000_000) {
    return `${(vol / 1_000_000).toFixed(1)}M`;
  }
  if (vol >= 1_000) {
    return `${(vol / 1_000).toFixed(0)}K`;
  }
  return String(Math.floor(vol));
}

function formatRow(m) {
  const prices = "`" + zipOutcomes(m.outcomes, m.outcomePrices) + "`";
  const timeLeft = "`" + (m.timeToEnd || (m.endDate ? computeTimeLeftFromEndDate(m.endDate) : "")) + "`";
  const volume = m.volume !== null && m.volume !== undefined ? "`$" + formatVolume(m.volume) + "`" : "";
  const score = m.score !== null && m.score !== undefined ? "`" + m.score + "/100`" : "";
  const q = "*" + escMD(m.question || "") + "*";
  const link = clickableNoPreview(m.eventUrl || m.url || "");
  // Two succinct lines per market with score
  return `• ${prices} • ⏳ ${timeLeft}${volume ? ` • 💰 ${volume}` : ""}${score ? ` • ⭐ ${score}` : ""}\n  ${q}${link ? ` — ${link}` : ""}`;
}

function formatBucketList(bucketArray, bucketName) {
  if (!Array.isArray(bucketArray) || bucketArray.length === 0) {
    return `**${bucketName}**\n_No markets found_`;
  }
  return `**${bucketName}**\n` + bucketArray.map(formatRow).join("\n");
}

function extractBucketsFromItems(items) {
  const out = { oneToFive: [], fiveToTen: [], tenToFifteen: [], fifteenToTwenty: [] };

  for (const it of items) {
    const j = it.json;

    // Case A: object with the keys
    for (const k of Object.keys(out)) {
      if (Array.isArray(j?.[k])) out[k] = j[k];
    }

    // Case B: outer array with one object (your sample)
    if (Array.isArray(j) && j.length && typeof j[0] === "object") {
      const first = j[0];
      for (const k of Object.keys(out)) {
        if (Array.isArray(first?.[k])) out[k] = first[k];
      }
    }
  }
  return out;
}

// ---------- MAIN ----------
const items = $input.all();
const buckets = extractBucketsFromItems(items);

const names = {
  oneToFive:      "1-5% opportunities",
  fiveToTen:      "5-10% opportunities",
  tenToFifteen:   "10-15% opportunities",
  fifteenToTwenty:"15-20% opportunities",
};

const texts = {};
const counts = {};
for (const key of Object.keys(names)) {
  texts[key]  = formatBucketList(buckets[key], names[key]);
  counts[key] = Array.isArray(buckets[key]) ? buckets[key].length : 0;
}

return [{ json: { texts, counts } }];