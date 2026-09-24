# reddit-monitor

Read-only monitor that finds Reddit posts where a business owner is asking what software to use, or describing a manual process that is costing them, and queues the good ones for a person to reply to by hand.

## What it does

1. Once an hour it reads the public "new posts" feed (RSS) of each subreddit in the list. No Reddit API key, no login.
2. A keyword filter keeps posts that are about software, systems or process problems and read as a question or a complaint. Posts that are selling, hiring or promoting are dropped.
3. Each kept post goes to Claude through the Claude Code command in headless mode, so it runs on the Claude subscription of whoever is logged in on the machine (no API key, no per-token bill; `SCORER=api` switches to the paid API if ever needed). Claude scores the fit 1 to 5, says what kind of business and what they need, and drafts a peer-style reply in the Optemate voice (plain words, diagnose first, two or three honest tool options with a catch each, then the "it can be a small custom layer on top of what you have" reframe, one soft DM line, never a link, never the company name).
4. Posts scoring 4 or 5 become a card on the board's **Reddit leads** holding board ("To Review" column), which is separate from the Sales and Nurture pipelines. The Full summary holds the post, the score, what they need and the draft reply. Everything scored is also appended to `matches.csv`.
5. A person reads the card, edits the draft, posts it from their own Reddit account, and drags the card to Replied. If the poster turns into a real conversation, "Move to pipeline" on the card approves it into Sales; otherwise Skipped. Nothing reaches the real pipeline without that click, and nothing is ever written to Reddit by this script.

## F5Bot alerts (optional second source)

F5Bot (f5bot.com, free) emails an alert whenever a chosen phrase appears anywhere on Reddit, including comments the feed list never sees. F5Bot has no API, so the alerts are read inside the optemate Google account by a small Apps Script (`f5bot-apps-script.js` in this repo) that appends each Reddit link to a Google Sheet every 15 minutes. The sheet is published as a read-only CSV link, and the monitor polls that link each pass: it fetches the post through its own feed, scores it like a feed hit, and marks the source as the F5Bot keyword. No email password is stored anywhere.

Setup: paste `f5bot-apps-script.js` into script.google.com in the optemate account, run `setup` once and approve it, open the sheet it names, File > Share > Publish to web > Sheet1 > CSV, and put that link in `.env` as `F5BOT_CSV`.

## Daily routine

Ten minutes: open the Reddit board, read each card in To Review, open the post, edit the draft so it sounds like you, post it, drag the card to Replied. When someone DMs back and it is a real business, fill in their details and click "Move to pipeline". Skipped for the rest. Never post a draft unread.

## Setup

```
claude                   # once: make sure Claude Code is installed and logged in on this machine
cp .env.example .env     # fill in MCP_API_KEY
npm install
npm run scan             # feed + keyword filter only, no AI, no board: sanity check
npm run dry              # scores and drafts, writes matches.csv, does not touch the board
npm run once             # one full pass
npm start                # one pass now, then every hour
```

The pipeline dev server has to be running for the board hand-off (`MCP_URL`, default `http://localhost:3000/api/mcp`). Without `MCP_API_KEY` the script still scores and writes the CSV.

## Running it on a schedule (Windows)

One hourly Task Scheduler job. It goes through `run-hidden.vbs` so no command window pops up while it runs (output goes to `monitor.log`):

```
schtasks /Create /SC HOURLY /TN "Optemate Reddit Monitor" /TR "wscript.exe \"C:\Users\scott\OneDrive\Desktop\Projects\More Work\Optemate\reddit-monitor\run-hidden.vbs\"" /F
```

## Config

All via `.env`:

| variable | default |
|---|---|
| `SCORER` | `claude-code` (subscription, via the logged-in Claude Code command) or `api` (needs `ANTHROPIC_API_KEY`) |
| `MCP_API_KEY`, `MCP_URL` | the pipeline board; omit to skip the board |
| `SUBREDDITS` | 17 subreddits: small business, trades, salons, restaurants, bookkeeping, photography |
| `MIN_SCORE` | `4` |
| `INTERVAL_MIN` | `60` |
| `CLAUDE_MODEL` | `sonnet` for the subscription scorer, `claude-opus-5` for the API |
| `OUT_FILE` | `./matches.csv` |

## Volume and manners

One feed request per subreddit per hour, two seconds apart, with a long back-off on 429. Well under anything Reddit rate-limits. It reads only what is public, stores only the post text and link for matched posts, and never posts, votes, messages or logs in.
