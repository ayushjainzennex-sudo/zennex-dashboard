# Topic research tab: how to remove it

The tab is built on the `topic-research` git branch. Everything it adds is either a new file or a line marked
`topic-research (RESEARCH.md)`, so it can be taken out cleanly.

## Easiest: don't merge the branch
If it isn't wanted, switch back to `main` and delete the branch:

    git switch main
    git branch -D topic-research

## If it was already merged
Delete these files:

- `server/research.js`
- `server/research-db.js`
- `server/research-ai.js` (AI brief; also remove `GEMINI_API_KEY` / `GEMINI_MODEL` from `.env` if you like)
- `api/research.js`
- `src/pages/research.jsx`
- `RESEARCH.md`

Then remove the marked lines:

- `server/api.js`: the imports from `./research-db.js`, `./research.js` and `./research-ai.js`, and the `/api/research/*` routes
  under the `// topic-research` comment.
- `src/main.jsx`: the `ResearchPage` import, the `nav('research', …)` line, the `page === 'research'` line, and
  `research:'Topic research'` in the two page-title lists.
- `src/style.css`: the blocks from `/* topic-research (RESEARCH.md): start */` to `/* topic-research AI picks v2: end */`.

It adds no database tables. Saved ideas and AI picks live in two rows of the `settings` table (`research.saved`, `research.picks`); to clear them:

    DELETE FROM settings WHERE key IN ('research.saved', 'research.picks', 'research.profile', 'research.feedback');

Plans created with "Send to Planner" are ordinary Planner entries (their ids start with `rs-`); delete them in the
Planner if you don't want them.
