// Read-only Reddit monitor.
// Once an hour: fetch new public posts from a few subreddits, keep the ones where the poster
// seems to be looking for software / an app / a system for their business, and append them
// to a local CSV for a person to read. Nothing is ever written back to Reddit.

import fs from "fs";
import path from "path";

// ---- config (env, with sensible defaults) -------------------------------------------------
const CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
const USER_AGENT = process.env.REDDIT_USER_AGENT || "optemate-monitor/1.0 (read-only; contact optemate@gmail.com)";
const SUBREDDITS = (process.env.SUBREDDITS || "smallbusiness,Entrepreneur,EntrepreneurRideAlong,startups,sweatystartup,Contractor,Bookkeeping,Hairstylist,Photography").split(",").map((s) => s.trim()).filter(Boolean);
const OUT_FILE = process.env.OUT_FILE || path.join(process.cwd(), "matches.csv");
const SEEN_FILE = process.env.SEEN_FILE || path.join(process.cwd(), "seen.json");
const INTERVAL_MIN = Number(process.env.INTERVAL_MIN || 60);
const POSTS_PER_SUB = Math.min(Number(process.env.POSTS_PER_SUB || 50), 100);

// Words that suggest someone is asking what software or system to use.
const KEYWORDS = [
  /\b(software|app|apps|system|platform|tool|tools|crm|erp|pos|point of sale|inventory|scheduling|dispatch|invoicing|booking)\b/i,
];
const ASKING = /\b(recommend\w*|suggest\w*|what .{0,40}\b(use|using|run|running)\b|looking for|anyone (use|using|know)|any (good|decent|cheap)|best .{0,40}\b(software|app|apps|tool|tools|system|platform|crm|pos)\b|which .{0,40}\b(software|app|apps|tool|tools|system|platform|crm|pos)\b|help me (find|choose|pick)|should i (use|get|buy))\b/i;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET (see .env.example).");
  process.exit(1);
}

// ---- helpers -----------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const csvCell = (s) => `"${String(s ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"))); } catch { return new Set(); }
}
function saveSeen(seen) {
  // keep the file from growing forever
  const arr = [...seen].slice(-5000);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(arr));
}

// Application-only OAuth ("client credentials"). No user account, no permission to post.
async function getToken() {
  const r = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`token request failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.access_token;
}

async function fetchNew(token, sub) {
  const r = await fetch(`https://oauth.reddit.com/r/${sub}/new?limit=${POSTS_PER_SUB}&raw_json=1`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
  });
  // respect the rate-limit headers Reddit sends back
  const remaining = Number(r.headers.get("x-ratelimit-remaining") ?? 60);
  const reset = Number(r.headers.get("x-ratelimit-reset") ?? 60);
  if (r.status === 429 || remaining < 2) { await sleep((reset + 1) * 1000); }
  if (!r.ok) { console.error(`r/${sub}: ${r.status}`); return []; }
  const j = await r.json();
  return (j.data?.children ?? []).map((c) => c.data);
}

function matches(post) {
  const text = `${post.title}\n${post.selftext ?? ""}`;
  return KEYWORDS.some((k) => k.test(text)) && ASKING.test(text);
}

// ---- one pass -----------------------------------------------------------------------------
async function runOnce() {
  const seen = loadSeen();
  const token = await getToken();
  let found = 0, checked = 0;
  if (!fs.existsSync(OUT_FILE)) fs.writeFileSync(OUT_FILE, "found_at,subreddit,title,link\n");
  for (const sub of SUBREDDITS) {
    const posts = await fetchNew(token, sub);
    for (const p of posts) {
      checked++;
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      if (!matches(p)) continue;
      const link = "https://www.reddit.com" + p.permalink;
      fs.appendFileSync(OUT_FILE, [new Date().toISOString(), "r/" + sub, p.title, link].map(csvCell).join(",") + "\n");
      found++;
      console.log(`match  r/${sub}  ${p.title}\n       ${link}`);
    }
    await sleep(1500); // be polite between subreddits
  }
  saveSeen(seen);
  console.log(`${new Date().toISOString()}  checked ${checked} posts across ${SUBREDDITS.length} subreddits, ${found} new matches -> ${OUT_FILE}`);
}

// ---- main ---------------------------------------------------------------------------------
const once = process.argv.includes("--once");
await runOnce();
if (!once) {
  console.log(`running every ${INTERVAL_MIN} minutes; Ctrl+C to stop`);
  setInterval(() => runOnce().catch((e) => console.error(e.message)), INTERVAL_MIN * 60 * 1000);
}
