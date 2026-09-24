// Reddit lead monitor, read-only.
// Every hour: read each subreddit's public "new posts" feed (RSS, no API key), keep the posts where a
// business owner is asking about software or describing a process problem, have Claude score each one
// and draft a peer-style reply, and put the good ones on the Optemate pipeline board (Nurture pipeline)
// for a person to review and post by hand. Nothing is ever written to Reddit.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

// ---- config (env, with defaults) ---------------------------------------------------------
const SUBREDDITS = (process.env.SUBREDDITS || "smallbusiness,Entrepreneur,sweatystartup,Contractor,Bookkeeping,Hairstylist,Photography,restaurateur,msp,HVAC,Plumbing,electricians,landscaping,Autobody,cleaningbusiness,lawncare,smallbusinessuk").split(",").map((s) => s.trim()).filter(Boolean);
const USER_AGENT = process.env.REDDIT_USER_AGENT || "optemate-monitor/2.0 (read-only feed reader; contact optemate@gmail.com)";
const OUT_FILE = process.env.OUT_FILE || path.join(process.cwd(), "matches.csv");
const SEEN_FILE = process.env.SEEN_FILE || path.join(process.cwd(), "seen.json");
const DRAFTS_FILE = process.env.DRAFTS_FILE || path.join(process.cwd(), "drafts.md");   // every drafted reply, newest last, for review without the board
const INTERVAL_MIN = Number(process.env.INTERVAL_MIN || 60);
const MIN_SCORE = Number(process.env.MIN_SCORE || 4);          // 1-5; this and above go on the board
const MCP_URL = process.env.MCP_URL || "http://localhost:3000/api/mcp";
const MCP_KEY = process.env.MCP_API_KEY;
// SCORER: "claude-code" runs the Claude Code CLI in headless mode on the machine's subscription login (default);
// "api" uses the Anthropic SDK with ANTHROPIC_API_KEY (pay per token).
const SCORER = process.env.SCORER || "claude-code";
const MODEL = process.env.CLAUDE_MODEL || (SCORER === "api" ? "claude-opus-5" : "sonnet");
const once = process.argv.includes("--once");
const noAi = process.argv.includes("--no-ai");                  // list matches only, no scoring, no board
const noBoard = process.argv.includes("--no-board");            // score and draft, but only write the CSV

// Words that suggest the post is about software, systems or a process problem.
const TOPIC = /\b(software|app|apps|system|systems|platform|tool|tools|crm|erp|pos|point of sale|inventory|scheduling|schedule|dispatch|invoicing|invoice|booking|quickbooks|spreadsheet|spreadsheets|excel|google sheets|automate|automation|manual|paperwork|tracking|workflow|database|portal|website)\b/i;
// Words that suggest they are asking or complaining, not selling or announcing.
const ASKING = /\b(recommend\w*|suggest\w*|what (?:do|does|are|is|should)|looking for|anyone (?:use|using|know|have)|any (?:good|decent|cheap|better)|best .{0,40}\b(?:software|app|apps|tool|tools|system|platform|crm|pos)\b|which .{0,40}\b(?:software|app|apps|tool|tools|system|platform|crm|pos)\b|help me|should i|how do (?:you|i)|how are you (?:all |guys )?(?:tracking|managing|handling)|tired of|sick of|frustrated|nightmare|struggling|mess|falling through the cracks|by hand|manually|too many (?:apps|tools|subscriptions|spreadsheets))\b/i;
// Posts to skip outright: people selling, hiring, or promoting.
const SKIP = /\b(dm me for|check out my|i built|we built|i made|launching|launched|my (?:new )?(?:app|tool|saas|startup)|free trial|promo code|affiliate|hiring|job opening|for sale|feedback on my)\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const csvCell = (s) => `"${String(s ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#32;/g, " ").replace(/&amp;/g, "&");
const stripHtml = (s) => decode(decode(s)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function loadSeen() { try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"))); } catch { return new Set(); } }
function saveSeen(seen) { fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen].slice(-10000))); }

// ---- feed reading --------------------------------------------------------------------------
async function fetchNew(sub) {
  const url = `https://www.reddit.com/r/${sub}/new.rss?limit=50`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/atom+xml, application/xml" }, signal: AbortSignal.timeout(20000) });
      if (r.status === 429) { await sleep(30000 * (attempt + 1)); continue; }
      if (!r.ok) { console.error(`r/${sub}: HTTP ${r.status}`); return []; }
      return parseAtom(await r.text(), sub);
    } catch (e) { await sleep(5000); }
  }
  return [];
}

function parseAtom(xml, sub) {
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id = e.match(/<id>([^<]+)<\/id>/)?.[1] ?? "";
    const title = decode(e.match(/<title>([^<]*)<\/title>/)?.[1] ?? "");
    const link = e.match(/<link href="([^"]+)"/)?.[1] ?? "";
    const author = decode(e.match(/<author>\s*<name>([^<]*)<\/name>/)?.[1] ?? "").replace(/^\/u\//, "");
    const updated = e.match(/<updated>([^<]+)<\/updated>/)?.[1] ?? "";
    const body = stripHtml(e.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? "").replace(/\s*submitted by\s+\/u\/\S+.*$/i, "").trim();
    if (id && title) out.push({ id, sub, title, link, author, updated, body });
  }
  return out;
}

function prefilter(p) {
  const text = `${p.title}\n${p.body}`;
  if (SKIP.test(text)) return false;
  return TOPIC.test(text) && ASKING.test(text);
}

// ---- scoring and draft reply -------------------------------------------------------------------
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    fit: { type: "integer", minimum: 1, maximum: 5, description: "1 = not a lead, 5 = a business owner clearly asking for software or describing a process problem we could solve" },
    is_business_owner: { type: "boolean" },
    niche: { type: "string", description: "the kind of business, in plain words, e.g. 'two-truck HVAC company'" },
    need: { type: "string", description: "one sentence: what they actually need, in plain words" },
    stage: { type: "string", description: "one of: active pain, acute crisis, pre-purchase, deep researcher, vague pain, beginner, cost-conscious, multi-need, custom-curious, brief" },
    why: { type: "string", description: "one sentence on why this score" },
    reply: { type: "string", description: "the drafted Reddit comment, or an empty string if fit is below 3" },
  },
  required: ["fit", "is_business_owner", "niche", "need", "stage", "why", "reply"],
  additionalProperties: false,
};

const SYSTEM = `You screen Reddit posts for Optemate, a small US company that builds custom software, automations, integrations and websites for owner-run businesses (trades, salons, restaurants, distributors, small manufacturers, professional services). A person will read your output and decide whether to reply by hand; nothing you write is posted automatically.

Score each post for fit:
5: a business owner clearly asking what software or system to use, or describing a manual, spreadsheet, paper or duct-taped process that is costing them, with enough detail to reply to.
4: same, but thinner detail, or the need is smaller.
3: possibly a lead; ambiguous who they are or what they want.
2: an employee, a student, a hobbyist, or a question with no software angle.
1: someone selling, hiring, promoting, or off topic.

If fit is 3 or higher, draft the reply. Voice rules for the reply, all of them mandatory:
- Sound like an experienced peer business owner typing on their phone, not a consultant or a company. Plain words. Sentence fragments are fine. No bolding, no headers, no bulleted lists.
- No em dashes anywhere. No empathy openers ("I hear you", "great question"). Lead with the most useful observation.
- Diagnose before recommending: ask two or three specific questions about where exactly it breaks, phrased so they can answer in a reply.
- Name two or three real tools they could use, one honest take each, including a catch for each. Be selective, not comprehensive. Use their trade's vocabulary. Do not invent prices; if unsure say "worth checking the current pricing".
- Then the reframe: the piece they are missing does not have to live inside their main software; it can be a small custom layer on top of what they already use, and describe what that would look like in their world.
- End with one soft line: "If you want to talk through what that would look like for your setup, happy to in DMs." Never name Optemate, never link anything, never mention prices for custom work.
- 150 to 350 words. Shorter for short posts.`;

const postText = (p) => `Subreddit: r/${p.sub}\nAuthor: u/${p.author}\nTitle: ${p.title}\n\nPost:\n${p.body || "(no body text)"}`;
const DECLINED = { fit: 1, is_business_owner: false, niche: "", need: "", stage: "", why: "declined", reply: "" };

// Headless Claude Code: uses whoever is logged in to `claude` on this machine (the subscription), no API key.
// Spawned as a real executable (no shell) so the long system prompt and the JSON schema pass through untouched.
function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  if (process.platform === "win32") {
    const home = process.env.USERPROFILE || "";
    const candidates = [   // the npm install is the one `claude` on PATH runs; the .local copy can be an older version
      path.join(process.env.APPDATA || "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
      path.join(home, ".local", "bin", "claude.exe"),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
  }
  return "claude";
}

function scoreWithClaudeCode(p) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--model", MODEL, "--tools", "", "--exclude-dynamic-system-prompt-sections",
      "--system-prompt", SYSTEM, "--json-schema", JSON.stringify(VERDICT_SCHEMA)];
    const env = { ...process.env, CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined };   // allow launching from inside a Claude Code session
    const child = spawn(claudeBin(), args, { shell: false, windowsHide: true, env });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      let j;
      try { j = JSON.parse(out); } catch { return reject(new Error(`claude returned non-JSON (exit ${code}): ${(err || out).slice(0, 200)}`)); }
      if (j.is_error || /not logged in/i.test(j.result || "")) return reject(new Error(`claude error: ${String(j.result).slice(0, 200)}`));
      if (!j.structured_output) return reject(new Error(`no structured output: ${String(j.result).slice(0, 200)}`));
      resolve(j.structured_output);
    });
    child.stdin.end(postText(p));
  });
}

// Anthropic SDK, pay per token. Only loaded when SCORER=api.
let client = null;
async function scoreWithApi(p) {
  if (!client) { const { default: Anthropic } = await import("@anthropic-ai/sdk"); client = new Anthropic(); }
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: postText(p) }],
    output_config: { effort: "medium", format: { type: "json_schema", schema: VERDICT_SCHEMA } },
  });
  if (res.stop_reason === "refusal") return DECLINED;
  return res.parsed_output ?? JSON.parse(res.content.find((b) => b.type === "text")?.text ?? "{}");
}

// The voice rules say no em dashes and no bullet structure; the model still slips some in, so clean them here.
function tidyReply(text) {
  return String(text || "")
    .replace(/\s*[—–]\s*/g, ", ")            // em and en dashes become commas
    .replace(/,\s*,/g, ",")
    .replace(/^\s*[-*•]\s+/gm, "")               // leading list markers
    .replace(/\*\*/g, "")                              // bold
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
const rawScore = SCORER === "api" ? scoreWithApi : scoreWithClaudeCode;
async function score(p) { const v = await rawScore(p); v.reply = tidyReply(v.reply); return v; }

// ---- pipeline board -----------------------------------------------------------------------------
async function mcp(name, args) {
  const r = await fetch(MCP_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${MCP_KEY}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
  });
  const txt = await r.text();
  const line = txt.split("\n").find((l) => l.startsWith("data: "));
  const json = JSON.parse(line ? line.slice(6) : txt);
  if (json.error) throw new Error(JSON.stringify(json.error));
  const c = json.result?.content?.[0]?.text;
  try { return JSON.parse(c); } catch { return c; }
}

function serviceFor(v) {
  const t = `${v.need} ${v.niche}`.toLowerCase();
  if (/website|web site|online booking page|seo/.test(t)) return "web";
  if (/connect|sync|talk to each other|integrat|quickbooks/.test(t)) return "integration";
  if (/automat|reminder|manual|by hand|spreadsheet|paper/.test(t)) return "automation";
  return "software";
}

async function toBoard(p, v) {
  const today = new Date().toLocaleDateString("en-US");
  const contact = await mcp("create_contact", {
    first_name: `u/${p.author || "unknown"}`, last_name: "(Reddit)", company: `${v.niche || "business"} (r/${p.sub})`, website: p.link, source: "manual",
  });
  const cid = contact.contact?.id ?? contact.id;
  if (!cid) throw new Error("no contact id: " + JSON.stringify(contact).slice(0, 200));
  const summary = [
    `REDDIT LEAD - u/${p.author} in r/${p.sub} (fit ${v.fit}/5, stage: ${v.stage})`,
    ``,
    `WHO THEY ARE`,
    `- ${v.niche}. Reddit user u/${p.author}; identity unknown until they DM back.`,
    ``,
    `WHAT THEY ASKED`,
    `- ${v.need}`,
    `- Why this score: ${v.why}`,
    ``,
    `THE POST (${p.updated.slice(0, 10)})`,
    `- Title: ${p.title}`,
    `- ${p.body ? p.body.slice(0, 2500) : "(no body text)"}`,
    `- Link: ${p.link}`,
    ``,
    `DRAFT REPLY (edit before posting; post from your own account, never a link, never the company name)`,
    v.reply,
    ``,
    `NEXT STEP`,
    `- Post the reply from the warmed account. If they DM back, move this to Drip Active and fill in the real business details. If nobody bites in 7 days, mark Dead.`,
    ``,
    `SOURCE`,
    `- Where we found them: the public new-posts feed of r/${p.sub}, read by the Reddit monitor on ${today}.`,
    `- How we confirmed the problem: their own words in the post; nothing else verified yet.`,
  ].join("\n");
  const deal = await mcp("create_deal", {
    contact_id: cid, service: serviceFor(v), pipeline: "nurture", stage: "To Nurture",
    title: `Reddit: ${v.niche || "owner"} asking about ${v.need.slice(0, 70)}`,
    scope: `u/${p.author} in r/${p.sub} (fit ${v.fit}/5): ${v.need}\nPost: ${p.link}\nReply drafted in the full summary; post it by hand.`,
    summary,
  });
  return deal.deal?.id ?? deal.id;
}

// ---- one pass -----------------------------------------------------------------------------------
async function runOnce() {
  const seen = loadSeen();
  if (!fs.existsSync(OUT_FILE)) fs.writeFileSync(OUT_FILE, "found_at,subreddit,author,fit,stage,niche,need,title,link,on_board\n");
  let checked = 0, matched = 0, scored = 0, boarded = 0;
  for (const sub of SUBREDDITS) {
    const posts = await fetchNew(sub);
    for (const p of posts) {
      checked++;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (!prefilter(p)) continue;
      matched++;
      if (noAi) { console.log(`match  r/${sub}  ${p.title}\n       ${p.link}`); fs.appendFileSync(OUT_FILE, [new Date().toISOString(), sub, p.author, "", "", "", "", p.title, p.link, ""].map(csvCell).join(",") + "\n"); continue; }
      let v;
      try { v = await score(p); scored++; }
      catch (e) {
        if (/rate|429|usage limit/i.test(e.message)) { await sleep(60000); try { v = await score(p); } catch (e2) { console.error("score failed twice:", e2.message); continue; } }
        else { console.error("score failed:", e.message); continue; }
      }
      let dealId = "";
      if (v.fit >= MIN_SCORE && !noBoard && MCP_KEY) {
        try { dealId = await toBoard(p, v); boarded++; } catch (e) { console.error("board failed:", e.message); }
      }
      fs.appendFileSync(OUT_FILE, [new Date().toISOString(), sub, p.author, v.fit, v.stage, v.niche, v.need, p.title, p.link, dealId].map(csvCell).join(",") + "\n");
      if (v.fit >= 3 && v.reply) fs.appendFileSync(DRAFTS_FILE, `## ${v.fit}/5  r/${sub}  ${p.title}\n${p.link}\n${v.niche} | ${v.stage} | ${v.need}\n\n${v.reply}\n\n---\n\n`);
      console.log(`${v.fit}/5  r/${sub}  ${p.title}${dealId ? "  -> on board" : ""}\n       ${p.link}`);
    }
    saveSeen(seen);
    await sleep(2000);
  }
  console.log(`${new Date().toISOString()}  ${checked} posts across ${SUBREDDITS.length} subreddits, ${matched} matched, ${scored} scored, ${boarded} put on the board -> ${OUT_FILE}`);
}

// ---- main ---------------------------------------------------------------------------------------
export { fetchNew, prefilter, score, mcp, toBoard, runOnce };

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  await runOnce();
  if (!once) {
    console.log(`running every ${INTERVAL_MIN} minutes; Ctrl+C to stop`);
    setInterval(() => runOnce().catch((e) => console.error(e.message)), INTERVAL_MIN * 60 * 1000);
  }
}
