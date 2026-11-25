# Channel Studio (YouTube Dashboard)

Analytics for three YouTube channels plus any competitors, built on public YouTube data, a local SQLite database and hourly updates.

Runs locally on **Windows, macOS and Linux**. Requires **Node 22.13 or newer** (it uses the built-in `node:sqlite`; `.nvmrc` pins 22).

```bash
npm install
npm run dev        # development, http://localhost:5173
npm run serve      # production build, http://localhost:4173
```

Moving the project to another computer: copy the folder **without** `node_modules` (and `dist`), then run `npm install` there. Copy `data/dashboard.db` too if you want to keep your history.

## Features
| Area | What it does |
|---|---|
| Overview | Network totals, channel cards, latest uploads, trending, launch tracker, outliers, comparison |
| Channel pages | Growth, milestone projection, content mix, launch tracker, outliers, recent uploads |
| Insights | Best time to post (heatmap), price segments, title keywords that lift or drag performance |
| Competitors | Add by handle/link, you-vs-them table, head-to-head, upload feed, outliers, topic gaps → planner |
| Rankings | Categories → subcategories (e.g. Laptop → Under ₹60K) → 5–6 search queries each. Checks YouTube search (India) every 6 hours; alerts when the channel misses the top 2 for most queries in a subcategory, or doesn't appear at all |
| Weekly report | 7-day summary for your channels and competitors; print or save as PDF |
| Alerts | Outliers, rankings, milestones, competitor uploads, published plans; desktop notifications; Discord/Slack via Settings |
| Planner | Stored in the database; list and calendar views; auto-marked Published when the video goes live |

## Data
- `data/dashboard.db` (git-ignored): `channels`, `channel_snapshots`, `videos`, `video_snapshots`, `alerts`, `plans`, `runs`.
- Every 60 minutes while a server runs: About page stats + RSS feed (last 15 uploads, exact views/likes). Once a day: ~30 videos and ~30 Shorts from the channel pages to widen baselines (views rounded, dates estimated, flagged `approx`).
- **Outlier score** = views ÷ median views of the same channel's other videos of the same format. ≥ 2× is an outlier.
- **Launch pace** = a new video's views vs the channel's median views at the same age (needs a few videos tracked from upload).

## Always on (start at sign-in)
```bash
npm run autostart:install     # Windows: Startup shortcut · macOS: LaunchAgent · Linux: XDG autostart
npm run autostart:status
npm run autostart:uninstall
```
The dashboard then runs at http://localhost:4173 whenever you're signed in. Logs go to `data/server.log`. If both a dev and an autostart server run, only one performs each hourly update.

## Discord & Slack alerts
Open **Settings** in the sidebar, paste a Discord or Slack incoming-webhook URL, save, and press **Send test**. You can pause each one and pick which alert types it receives. URLs are stored in `data/dashboard.db` and only shown masked. (`DISCORD_WEBHOOK_URL` still works as a fallback when nothing is saved.)
