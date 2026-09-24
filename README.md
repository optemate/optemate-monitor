# reddit-monitor

Read-only monitor that finds Reddit posts where a business owner is asking what software to use, or describing a manual process that is costing them, and queues the good ones for a person to reply to by hand.

## What it does

1. Once an hour it reads the public "new posts" feed (RSS) of each subreddit in the list. No Reddit API key, no login.
2. A keyword filter keeps posts that are about software, systems or process problems and read as a question or a complaint. Posts that are selling, hiring or promoting are dropped.
3. Each kept post goes to Claude, which scores the fit 1 to 5, says what kind of business and what they need, and drafts a peer-style reply in the Optemate voice (plain words, diagnose first, two or three honest tool options with a catch each, then the "it can be a small custom layer on top of what you have" reframe, one soft DM line, never a link, never the company name).
4. Posts scoring 4 or 5 become a lead on the Optemate pipeline board, Nurture pipeline, "To Nurture" stage. The Full summary holds the post, the score, what they need and the draft reply. Everything scored is also appended to `matches.csv`.
5. A person reads the lead, edits the draft, and posts it from their own Reddit account. Nothing is ever written to Reddit by this script.

## Daily routine

Ten minutes: open the Nurture column, read each new card, open the post, edit the draft so it sounds like you, post it. Move the card to Drip Active if they DM back, or Dead after a week of silence. Never post a draft unread.

## Setup

```
cp .env.example .env     # fill in ANTHROPIC_API_KEY and MCP_API_KEY
npm install
npm run scan             # feed + keyword filter only, no AI, no board: sanity check
npm run dry              # scores and drafts, writes matches.csv, does not touch the board
npm run once             # one full pass
npm start                # one pass now, then every hour
```

The pipeline dev server has to be running for the board hand-off (`MCP_URL`, default `http://localhost:3000/api/mcp`). Without `MCP_API_KEY` the script still scores and writes the CSV.

## Running it on a schedule (Windows)

One hourly Task Scheduler job, run whether or not you are logged in:

```
schtasks /Create /SC HOURLY /TN "Optemate Reddit Monitor" /TR "cmd /c cd /d \"C:\Users\scott\OneDrive\Desktop\Projects\More Work\Optemate\reddit-monitor\" && npm run once >> monitor.log 2>&1" /F
```

## Config

All via `.env`:

| variable | default |
|---|---|
| `ANTHROPIC_API_KEY` | required for scoring |
| `MCP_API_KEY`, `MCP_URL` | the pipeline board; omit to skip the board |
| `SUBREDDITS` | 17 subreddits: small business, trades, salons, restaurants, bookkeeping, photography |
| `MIN_SCORE` | `4` |
| `INTERVAL_MIN` | `60` |
| `CLAUDE_MODEL` | `claude-opus-5` |
| `OUT_FILE` | `./matches.csv` |

## Volume and manners

One feed request per subreddit per hour, two seconds apart, with a long back-off on 429. Well under anything Reddit rate-limits. It reads only what is public, stores only the post text and link for matched posts, and never posts, votes, messages or logs in.
