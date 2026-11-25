// SQL for thinning old snapshots (used by the daily cleanup in dbhealth.js; tested in test/retention.test.mjs).
// Parameters: (cutoff ISO time, cutoff ISO time[, launch days]).

// A video's first LAUNCH_DAYS keep every snapshot: new uploads are compared against older videos' launch curves.
export const LAUNCH_DAYS = 4;

// Older than the cutoff: keep the last snapshot of each day for each video, except inside its launch window.
export const THIN_VIDEOS = `DELETE FROM video_snapshots WHERE ts<? AND rowid NOT IN
  (SELECT max(rowid) FROM video_snapshots WHERE ts<? GROUP BY video, substr(ts,1,10))
  AND NOT EXISTS (SELECT 1 FROM videos v WHERE v.id=video_snapshots.video AND v.published IS NOT NULL
    AND julianday(video_snapshots.ts) - julianday(v.published) <= ?)`;

// Older than the cutoff: keep the last snapshot of each day for each channel (charts are daily; deltas look back ~30 days).
export const THIN_CHANNELS = `DELETE FROM channel_snapshots WHERE ts<? AND rowid NOT IN
  (SELECT max(rowid) FROM channel_snapshots WHERE ts<? GROUP BY channel, substr(ts,1,10))`;
