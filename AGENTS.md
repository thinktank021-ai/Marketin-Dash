# Marketing Dashboard — repository operating contract
Effective: 2026-11-01 (Gregorian, YYYY-MM-DD)
Canonical repository: https://github.com/thinktank021-ai/Marketin-Dash

This file is the mandatory entry point for every AI assistant, developer, designer and future session. Chat memory or prior session assertions are **not** authoritative. At the start of each task, fetch the current branch and read these repository files in this order:
1. `AGENTS.md` (this contract)
2. `PROJECT_RULES.md` (product/data integrity rules)
3. `docs/ZIARATI_2_SUMMARY.md` (release status and active backlog)
4. `docs/PROJECT_REPORT.txt` (architectural background; older snapshot)
5. `docs/DEVELOPMENT_LOG.md` (handoff and decision trail)
6. Relevant implementation and tests. Check git status, current PRs and recent commits before designing a fix.

## Non-negotiable architecture
- Standalone commercial product deployable to Cloudflare Workers, Node.js/PM2 on a VPS, and cPanel Node.js Selector/Passenger using `.cpanel.yml`, `server.js`, `loader.cjs`.
- D1/SQLite abstraction with local zero-config fallback.
- Strict DonyaGardi/Novavaran isolation for configurations, cache, data and credentials.
- Anti-zeroing: preserve the last *validated* cached snapshot on source failure, mark it Stale; no fabricated zero or silent partial replacement.
- Preserve accurate lead/channel/route/expert totals and attributed CPL/CAC semantics.
- Per release v0.260, «آژانسی» must be its own channel, distinct from «مسافر ثابت», «همکار» and «حضوری». If older rules conflict, record and reconcile the conflict explicitly.

## Task-by-task change protocol
1. One clearly scoped task at a time. Record exact objective, acceptance criteria, affected brands/environments, issue or task ID and base commit.
2. Inspect code and relevant tests before proposing changes; do not invent file paths, functions, results or deployment status.
3. Every implemented change **must be committed to this repository on a task-specific branch and submitted as a dated pull request**. Do not push directly to `main`. No silent edits or untracked work.
4. Each PR must document: date (ISO-8601 UTC), reason, exact modified paths, behavior before/after, compatibility and data risks, migration/fallback, test commands and *actual results*, review/rollback plan, related issue, and handoff status. If tests were not run, say so explicitly.
5. Update `docs/DEVELOPMENT_LOG.md` within the same PR with an entry for each task (including design-only decisions and known blockers), its date and PR link/number when available. Use the PR thread for changes/reviews and add a follow-up log entry when a PR is merged or rejected; never falsely claim a PR is merged.
6. Non-code product/design decisions must also be preserved in a dated documentation PR. Substantial design work should include specifications/assets or links to their canonical tracked sources.
7. Verify locally using relevant targeted tests, broader regression and build checks where possible. Never label unexecuted tests as passed. Provide commands and reproducible steps.
8. Do not include secrets, credentials, real customer PII, or unsafe production exports in commits, PRs, logs or diagnostics.
9. At the start of a new session, retrieve the latest repository state and outstanding PRs/issues. Resume exclusively from documented evidence; ask about contradictions rather than relying on remembered conversations.
10. After work, return exact branch, commit SHA, PR URL, paths and status; if any write/test failed, state the blocker and leave an explicit handoff record.

## Definition of done
A task is *implemented* only when its changes and tests are committed and its PR exists. It is *merged* only after merge confirmation. It is *released* only after deployment verification. Neither a suggestion nor a chat response counts as a repository change.

Repository documentation is the system of record; no claim can guarantee perfect persistence of conversations or events that were never written to GitHub.
