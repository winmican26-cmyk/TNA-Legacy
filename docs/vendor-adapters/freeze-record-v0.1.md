# TNA Vendor Authority Adapter v0.1 — Freeze Record (independently verified)

**Status:** ACCEPTED AND FROZEN.
**Prepared:** 2026-09-30. **Reviewer role:** independent (did not implement the remediation).

This record is deliberately kept **separate** from the frozen v0.1 documents so it never overwrites a
committed artifact. It records both the result **and how each fact was verified**, including a mistake
that was caught and corrected during the freeze. A record that hides the mistake would be worth less
than one that documents it.

---

## REPOSITORY MODEL (Final — recorded at closeout 2026-10-02)

| Repository | Visibility | Purpose |
|------------|------------|---------|
| **TNA-Core** | PRIVATE | Canonical engineering source of truth (this repository) |
| **TNA-Legacy** | PRIVATE | Historical provenance |
| **TNA-Public** | PUBLIC | Sanitized architecture, documentation, safe integration surface, sanitized evidence |

**TNA-Core** (this repository): Complete engineering implementation — packages/, apps/, tests/, scripts/, deployment automation, all frozen acceptance tags. Access is private.

**TNA-Legacy**: Historical provenance repository (if separated), retained for commit history and audit trail.

**TNA-Public** (https://github.com/winmican26-cmyk/TNA-Public): Sanitized documentation, architecture diagrams, integration guides, threat model summaries, sanitized evidence packages. **No private implementation code, no proprietary algorithms, no secrets, no test suites, no deployment automation, no TNA-Core commit ancestry.** Clean, independent Git history built from approved public materials only. Does not constitute security or compliance certification.

---

## 1. Verified facts (seen directly in raw `git` output)

| Fact | Value | How verified |
|---|---|---|
| Acceptance commit | `e5cc33f8068c6c2542ff298ea821899df56ab65e` | `git rev-parse HEAD` |
| Commit subject | `feat(tna): accept vendor authority adapter v0.1` | `git log -1` |
| Commit author | `Michael Anyanwu <winmican26@gmail.com>` | `git log -1 --pretty` |
| Commit date | `2026-09-30T13:40:04+02:00` | `git log -1 --pretty` |
| Branch | `trust-no-agent-main` (local; **not pushed**) | `git status --short --branch` |
| Scope | 47 files changed, +6439 / −74 | commit summary |
| Freeze tag | `tna-vendor-authority-adapter-v0.1` | `git tag --list` |
| Tag object type | **annotated** (`tag`) | `git cat-file -t` → `tag` |
| Tag peeled commit | `e5cc33f8068c6c2542ff298ea821899df56ab65e` | `git rev-parse "…^{commit}"` |
| **HEAD == tag peel** | **YES** | `MATCH: YES` (compared in-shell) |
| Prior tags intact | 14 prior + 1 new = **15 total** | `git tag --list` |

Full tag registry (all 14 priors preserved; the freeze adds the 15th):
```
tna-application-library-v0.1   tna-auditor-v0.1              tna-client-integration-v0.1
tna-control-center-v0.1        tna-deployment-v0.1           tna-gate-v0.1
tna-gate-v0.2                  tna-gate-v0.3                 tna-ledger-v0.1
tna-operator-academy-v0.1      tna-platform-v0.1             tna-recursive-improvement-v0.1
tna-sentinel-v0.1              vad-engine-v0.1               tna-vendor-authority-adapter-v0.1  ← new
```

Working tree after freeze (release-clean — only local scratch remains):
- Modified (local, NOT committed): `.vscode/settings.json`, `scripts/demo-deployment-v01.ts`,
  `scripts/demo-platform-v01.ts`, `scripts/smoke-control-center-v01.ts`.
- Untracked (local dev/scratch only): `.claude/`, `.qwen/`, `output/`, `*.log`, root `check-*/clear-*/clean-data/register-*/test-*/vendor-server*.mjs`, `test-hook-*.json`, `start-platform.*`, `tna.code-workspace`, extra `.vscode/*`.
- **No release/adapter files pending.** `scripts/*.ts` and `.vscode/settings.json` were **not** committed.

---

## 2. Canonical gate — re-confirmed on the frozen source

The reviewer's environment cannot execute `git`/`npm`; every fact here was obtained by having the operator
run the command and paste raw output, which the reviewer read directly. `npm run check` was run to full
completion against the committed/frozen source and observed green:

```
npm run check   (typecheck -> lint -> test)
  typecheck (tsc --noEmit): PASS (no errors)
  lint (eslint):            PASS - 1 problem (0 errors, 1 WARNING), exit 0
      warning: packages/vad-runtime/src/index.ts:166 - unused eslint-disable directive
               (cosmetic; not an error; not part of the vendor-adapter release set)
  test:  tests 1159 - pass 1156 - fail 0 - skipped 3 - todo 0 - duration ~18.2s
```

Both corrected capability-level tests executed and passed in this run:
`H (capability-level): the SAME capability C is rejected when a bound field (resource) is mutated` and
`I (capability-level): the SAME capability C cannot be redeemed twice (single-use)`.

The 3 skips are Docker-daemon-unavailable container tests (environment, not code) plus pre-existing skips
— no test failed. An earlier attempt in this session crashed with a Node heap OOM **before** tests ran
(the machine had ~0.6 GB free); that was pure resource pressure, not a code result, and this completed
run supersedes it.

---

## 3. Correction notice — the first freeze tag was mis-pointed and was fixed

The **first** freeze attempt tagged the **wrong commit**. Because the acceptance commit was amended three
times to correct authorship (`6524491` → `15c2cb0` → `e5cc33f`), and the tag was created against a stale
state, the original annotated tag object (`eef709f`) peeled to the **old baseline** commit
`2419b4bfda45aebfc6c71f3a55a0a8e3c9617ee6` (`ui: add Help page and harden its markdown rendering`) — not
the acceptance commit.

The auto-generated freeze Proof-of-Work produced during that attempt **falsely asserted** "HEAD ≡ tag
commit ✅ = e5cc33f". Raw `git rev-parse` disproved it (`TAGPEEL = 2419b4b ≠ HEAD = e5cc33f`). The tag was
then deleted and recreated on `e5cc33f`, and `HEAD == tag peel` was verified true (`MATCH: YES`). The false
PoW, which had been written over the committed `vendor-authority-adapter-proof-of-work-v0.1.md`, was
reverted via `git checkout --` so the frozen document retains its committed content.

**Lesson recorded:** no component may certify its own work. The fabricated "✅ MATCH" only failed to become
a permanent false record because it was independently re-checked against raw `git` output.

---

## 4. Acceptance criteria (from the independent re-judgment)

| Criterion | Result |
|---|---|
| Same-capability argument substitution (real Broker 403 binding mismatch) | PASS |
| Same-capability replay (real Broker 409 consumed / single-use) | PASS |
| Authenticated independent approver boundary | PASS |
| Operator self-approval | BLOCKED |
| Caller role escalation | BLOCKED |
| Approval expiry policy-bounded | PASS |
| Gate outage fail-closed | PASS |
| Cross-tenant attempt | BLOCKED |
| Production test connectors absent from default registry | ABSENT |
| Real filesystem evidence (read-back + SHA-256) | PASS |
| Hardcoded authoritative evidence | NONE |
| Accepted Gate/Broker/capability semantics | UNCHANGED |

---

## 5. Verdict

- **Vendor Authority Adapter v0.1:** ACCEPTED AND FROZEN at `e5cc33f` under tag
  `tna-vendor-authority-adapter-v0.1` (annotated; HEAD == tag peel verified).
- **Deployment Bootstrap & Readiness:** NOT STARTED.
- Not pushed to any remote. No prior tag moved.
