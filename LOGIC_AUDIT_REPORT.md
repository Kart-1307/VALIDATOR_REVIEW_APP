# Logic Audit Report

**Scope:** SAT Validator App (`src/`) — full-codebase review for logical mistakes, followed by targeted fixes.
**Date:** 2026-09-11
**Verification:** `npm run lint` (tsc --noEmit) ✅ · `npm run test` 44/44 ✅ · `npm run build` ✅
**Approach:** every finding below was verified by direct code read before being changed; no speculative refactors.

---

## Fixed bugs

### Data-integrity / status correctness

| # | File | Problem | Fix |
|---|------|---------|-----|
| 1 | `src/App.tsx` (~464,466), `src/components/NewBatchWorkspace.tsx` (~320,322) | Realtime merge used `||` for `explanation` and `question`, so an empty-string edit (or a realtime payload with `null` text) silently reverted the newer local value to the older one. `passage`/`stimulus` already used `??`. | `||` → `??` for `explanation` and `question`. |
| 2 | `App.tsx` + `NewBatchWorkspace.tsx` — `handleCategoryOverride` / `handleDifficultyOverride` / `handleClearOverride` | Reassigning category/difficulty, or clearing a manual override on an **approved** item, re-derived the status via `deriveOverallStatus` → demoted `approved` back to `pending`. `handleSetCheck` already had an approval-preservation guard; the override handlers did not. | Apply the same guard: `if (question.reviewStatus === 'approved' && derived === 'pending') derived = 'approved';` |
| 3 | `NewBatchWorkspace.tsx` — `deleteAllQuestions` (Wipe New Batch) | Wipe only cleared local React state. New Batch auto-loads from `questions_batch2`, so the "wiped" pool came back on reload. `removeBatch` already deletes server-side. | Delete the rows from `questions_batch2` in 500-id chunks before clearing state; return `false` (and toast) on error. Curator's Wipe is intentionally local-only (documented in-code; that pool loads from uploaded files, not the DB) and was left untouched. |
| 4 | `App.tsx` + `NewBatchWorkspace.tsx` — `sanitizeQuestion` | Uploaded files dropped `questionType` and `imageUrl`. Grid-in questions therefore became `mcq` and supporting-graphic URLs were lost on every export→re-upload round-trip. | Preserve `questionType` (infer `grid_in` when `choices` is absent) and `imageUrl`. |

### Lock / permission flow

| # | File | Problem | Fix |
|---|------|---------|-----|
| 5 | `QuestionCard.tsx` (footer) | "Quick Edit Item" / "Reset to Pending" were available to any non-auditor, letting a different validator clobber an item another user had claimed. | Hidden when locked by another validator, unless the viewer is an admin. |
| 6 | `App.tsx` / `NewBatchWorkspace.tsx` — `handleResetStatus`, `handleEditTrigger`, `handleSaveEditedQuestion` | Handler-level defense-in-depth was missing for the above (edit modal path could still be reached). | Early-return + error toast when `claimedBy` is someone else and viewer is not admin. |
| 7 | `App.tsx` / `NewBatchWorkspace.tsx` — `handleReleaseClaim` | Anyone could release a claim owned by someone else. | Only the claimant (or an admin) may release; otherwise error toast. |
| 8 | `App.tsx` / `NewBatchWorkspace.tsx` — `handleResolveConsensus` | Snapshot was written *before* the "is there actually a disagreement?" precondition check, so the "no-op" path still produced orphan `resolve_consensus` snapshots. | Move `snapshotQuestionBeforeChange` after the guard. |

### UI data correctness

| # | File | Problem | Fix |
|---|------|---------|-----|
| 9 | `App.tsx` / `NewBatchWorkspace.tsx` — `handleSelectAllVisible` | Button labeled "Select All Visible" selected all **filtered** rows (could be thousands), while the user only sees one page — enabling accidental large bulk actions. | Select only `paginatedQuestions`. Selection is also cleared on filter change and page-size change. |
| 10 | `App.tsx` / `NewBatchWorkspace.tsx` — `reviewedCount`/progress | "X of Y reviewed" excluded `needs_revision`, undercounting completed reviews. | Include `stats.needsRevision`. |
| 11 | `QuestionCard.tsx` — CheckToggle "No" button | Clicking "No" **twice** on a saved "Yes" first staged a fail, then reset the check to unanswered — silently erasing the saved "Yes". | "No" is disabled while the check is `true` (users clear the "Yes" first via its own undo). |
| 12 | `EditModal.tsx` | Grid-in questions had four `required` A/B/C/D inputs and an A–D-letter correct-answer `<select>`: the form could never submit for grid-in, and the numeric answer couldn't be entered/edited. | Choice inputs hidden and not required for grid-in; correct answer becomes a numeric text input; saving persists `choices: null`. |
| 13 | `AdminPanel.tsx` — Daily Snapshot "New Items" | Count only covered the Curator pool, omitting `questions_batch2`. | Add batch2 rows created that day. |
| 14 | `AdminPanel.tsx` — "N unique question(s) evaluated" | Was the *sum* of each validator's per-row unique counts → a question reviewed by two validators counted twice. | Use a single day-level set of touched question ids (+ bulk-action counts). |
| 15 | `DomainAnalytics.tsx` | `needs_revision` items fell into the `pending` bucket. | New explicit `needsRevision` bucket in domain/subdomain data + summary card, progress bar segment, legend, and sub-domain breakdown. |
| 16 | `ValidatorProgressModal.tsx` — per-validator activity | Substring name matching (`userLower.includes(...)`) could misattribute logs (e.g. "Rob" ↔ "Robert"). | Exact-name match (logs store the validator's own profile name). |
| 17 | `QuestionHistoryDrawer.tsx` — `loadSnapshots` | Racing fetches: switching between questions could let a stale, slower response clobber the newer one. | Request-id guard drops superseded responses. |

### Runtime/UX robustness

| # | File | Problem | Fix |
|---|------|---------|-----|
| 18 | `App.tsx` — `showToast` | Each toast scheduled a plain `setTimeout`; rapid toasts let an older timer dismiss a newer toast early. | `toastTimerRef` + `clearTimeout`; new toast restarts the timer. |
| 19 | `QuestionCard.tsx` — distractor copy button | `navigator.clipboard?.writeText(...).then(...)` threw `TypeError` when the Clipboard API is unavailable. | Guard the optional result before chaining `.then`. |
| 20 | `DesmosModal.tsx` | Calculator created while its container was `display:none` → Desmos measured 0×0 and rendered mis-sized. | Call `calculator.resize()` on next animation frame after the container becomes visible. |
| 21 | `AdminPanel.tsx` — validator scan | `const name = val.name || val.email` then `.trim()` crashed when a profile had neither. | Fall back to `'Unknown Validator'` before trimming. |
| 22 | `QuestionCard.tsx` — Distractor Quality panel | For grid-in questions (`choices: null`) the panel ran `analyzeDistractors` and reported four "Empty choice — must be filled in" flags for options that don't exist. | Grid-in questions now show a "no A/B/C/D choices to analyze" note instead. |
| 23 | `readFiles` (App + NewBatch) | Merged uploaded files against the `questions` closure captured at render time → a concurrent update (realtime) during parse could be lost. | Merge against a live `questionsRef` updated on every render. |

---

## Verified clean (no change needed)

- `src/lib/mathTools.ts` — `analyzeDistractors`/`suggestDistractors` already null-guard grid-in `choices`; the bogus "Empty choice" flags observed live were a card-level rendering issue, fixed in `QuestionCard.tsx` (see #22).
- `src/lib/tableText.tsx`, `src/lib/aiDesmosSolution.ts`, `src/lib/supabaseClient.ts`, `src/lib/consensus.ts`, `src/lib/mappers.ts` — no logic defects found.
- `src/components/DuplicateCompareModal.tsx` — already handles `choices: null`.

## Intentional non-changes

- **Bulk admin approve/reject + undo** — deliberately out of scope; per-question approval behavior was governed by the earlier requirements work, and bulk flows are a separate path.
- **`saveQuestions` diffing via render-snapshot `prevMap`** — the practical stale window was in `readFiles`, which is now fixed via `questionsRef`; no change to the write/diff design.
- **Pending-write counter released only in `.then`** — releases on success-with-error (the normal failure mode). Only a socket-level promise *rejection* could strand a counter; left alone to avoid churn for an edge case.
- **`deriveOverallStatus` never derives `approved`** — intentional design decision; the approval-preservation guards (fix #2) handle every transition that would otherwise demote an approved item.
- **Curator "Wipe Workspace" stays local-only** — documented in-code; the Curator pool loads from files, not the DB, so a local clear is a true fresh slate.

## Files touched

`src/App.tsx` · `src/components/NewBatchWorkspace.tsx` · `src/components/QuestionCard.tsx` · `src/components/EditModal.tsx` · `src/components/DesmosModal.tsx` · `src/components/AdminPanel.tsx` · `src/components/DomainAnalytics.tsx` · `src/components/QuestionHistoryDrawer.tsx` · `src/components/ValidatorProgressModal.tsx`