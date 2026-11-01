# Marketing Dashboard — dated development and decision log

Canonical repository: https://github.com/thinktank021-ai/Marketin-Dash

This is a handoff index, not a replacement for Git history or PR discussions. Use ISO-8601 dates; do not put credentials or passenger PII here. Every task should be represented by its PR and referenced here. Entries can be appended during implementation and supplemented by a subsequent PR when merge/release status changes.

## 2026-11-01 — Governance for cross-session development
- Type: Process / documentation
- Status: proposed in PR (not merged or released)
- Branch: `docs/cross-session-development-governance-2026-11-01`
- Change: introduced repo-first agent instructions, a dated PR template and a durable development handoff log.
- Scope: no application behavior changed.
- Verification: documentation-only; no app build/test claimed.
- PR: see the pull request for this branch.
- Goal: ensure new sessions read current repository evidence, and code, design and decisions are traceable through dated PRs.

## 2026-11-01 — Task 1: isolate «آژانسی» reporting channel
- Type: Backlog / investigation only
- Status: open, not implemented in repository by this governance PR.
- Source: `docs/ZIARATI_2_SUMMARY.md` release v0.260.
- Identified implementation: `app/dashboard-rules.ts`, especially `MERGED_PASSENGER_ALIASES`, `mergePassengerChannels`, `DEFAULT_DASHBOARD_RULES`; regression expectations in `tests/marketing-metrics.test.mjs`.
- Required behavior: «آژانسی» stays independent of «مسافر ثابت», «همکار» and «حضوری» in aggregations, counts and reports, remains cost-free, and old saved rules must migrate safely.
- Known conflict: an older line of `PROJECT_RULES.md` says «همکار» merges into «آژانسی», while v0.260 demands fully independent reporting. Reconcile and update the rule explicitly in the implementation PR.
- Validation outstanding: migration tests, duplicate alias handling before validation, source count reconciliation, financial attribution, per-brand isolation and all deployment builds.
- Next action: separate Task 1 implementation PR; do not treat prior chat code snippets as tested or committed.
