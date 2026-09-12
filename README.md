# reddit-monitor

A small read-only monitor that helps us spot small business owners on Reddit asking for software or tool recommendations, so someone on our team can go answer them properly.

## What it does

- About once an hour it fetches the newest public posts from a short list of subreddits (small business, entrepreneur, and a few trade specific ones).
- It checks the title and body for keywords that suggest the poster is looking for software, an app or a system for their business.
- Matching posts (time found, subreddit, title, link) get appended to a local CSV that our team reads.

That is the whole thing.

## What it does not do

- It never posts, comments, votes, or messages anyone. There is no code path that writes to Reddit.
- It uses application-only OAuth (client credentials), which has no user account behind it and no permission to post.
- It does not store post bodies, only the title and link of matches, and only in the internal CSV.
- It does not collect user profile data.
- It does not train any models on Reddit data.

Every reply to a Redditor is written and posted by hand by a person, from their own account, after reading the post.

## Volume

Nine subreddits, one request each per hour, plus one token request. Well under 100 requests a day. The script reads Reddit's `x-ratelimit-*` headers and backs off if they ever get low.

## Running it

```
cp .env.example .env     # fill in the client id and secret from reddit.com/prefs/apps
npm install              # nothing to install, Node 20+ is enough
node monitor.mjs --once  # one pass
node monitor.mjs         # run every hour
```

Matches land in `matches.csv`. `seen.json` remembers which posts were already checked so nothing is listed twice.

## Config

All optional, via `.env`:

| variable | default |
|---|---|
| `SUBREDDITS` | `smallbusiness,Entrepreneur,sweatystartup,Plumbing,HVAC,Construction,Truckers,Towing,restaurantowners` |
| `INTERVAL_MIN` | `60` |
| `POSTS_PER_SUB` | `50` |
| `OUT_FILE` | `./matches.csv` |
| `REDDIT_USER_AGENT` | `optemate-monitor/1.0 (read-only; contact optemate@gmail.com)` |
