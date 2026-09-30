# VAD — Independent Auditor Election (Atomized Processors & Judges)

**Purpose.** Establish, for the Final Security Boundary Remediation, an atomized verification pattern in
which **no component certifies its own work**. This mirrors the accepted VAD law
(`docs/vad/verifier-contract-v1.md`): *the Verifier judges produced work against the original spec and
deterministic evidence, never against self-reported producer claims.*

**Core rule (separation of duties).** For every acceptance criterion there are three distinct atomic
roles, and no single actor may hold two roles for the same criterion:

```
 PRODUCER  ──produces──▶  ARTIFACT/EFFECT  ──observed by──▶  VERIFIER  ──verdict──▶  JUDGE  ──ruling──▶  ledgered
 (does the work)          (real state)       (checks vs spec+evidence)              (independent accept/reject)
```

- **Producer** — the code/flow under test performs the real action (e.g. the platform executes an
  approved write). It emits *effects*, not verdicts.
- **Verifier (Processor)** — an atomic checker that reads **real observed state** (on-disk file, Gate
  decision, Ledger event) and compares it to the **original** criterion. It may not accept a
  producer's self-report (`written: true`, `state: COMPLETED`) as proof.
- **Judge** — an independent role that renders `ACCEPT | REJECT | REQUEST_CHANGES | INVALID` from the
  Verifier's evidence bundle. The Judge never re-runs the Producer and never sees producer claims,
  only the Verifier's evidence. Fails closed on missing/invented criteria.

**Independence invariants (enforced, not aspirational):**

1. The **agent** that requests an action is never its **approver** (distinct authenticated credential;
   token sets disjoint).
2. The **approver** is never the **resuming operator** (`approver.subjectId !== principal.id`).
3. The **Producer** of an effect is never the **Verifier** of that effect (the test reads the file back
   and hashes it independently of the connector's return value).
4. The **Verifier** is never the **Judge** (a Verifier reports evidence; a separate Judge rules).
5. The **implementer of the remediation** (this pass) is never the **final acceptor** — this election
   explicitly withholds final acceptance and routes it to an independent reviewer.

---

## Elected auditor roster (VAD atoms)

| VAD atom | Role | Independence source | Certifies | May NOT also be |
|---|---|---|---|---|
| **VAD-AUTH** | Verifier: approver authentication boundary | reads Gate `approval.issued` + credential map | criteria A, B, C, E, N | the resuming operator; the agent |
| **VAD-HOLD** | Verifier: genuine HOLD & fail-closed | reads platform state + Gate decision | criteria D, J, K | the Producer of the action |
| **VAD-EXEC** | Verifier: real controlled effect | reads on-disk file + SHA-256 | criteria G, H | the connector that wrote the file |
| **VAD-CAP** | Verifier: capability binding / replay | reads broker capability + consumed flag | criteria F, H, I, M | the broker under test |
| **VAD-EVID** | Verifier: provenance | reconstructs from Ledger/outbox | criterion O | any evidence Producer |
| **VAD-REG** | Verifier: registry hygiene | inspects default registry contents | criterion L | the registry builder |
| **JUDGE-1** | Judge: security boundary | consumes VAD-AUTH + VAD-HOLD bundles | Phase-1/2 rulings | any Verifier above |
| **JUDGE-2** | Judge: evidence & reproducibility | consumes VAD-EXEC/CAP/EVID/REG + build log | Phase-3/4/5 rulings | any Verifier above |
| **JUDGE-FINAL** | Judge: final acceptance | consumes JUDGE-1 + JUDGE-2 + independent build run | ACCEPT / REJECT | the remediation implementer |

**Atomization.** Each VAD atom is a single-purpose check with one input (real state), one comparison
(against the original criterion), and one output (evidence + local verdict). Atoms do not call each
other; a Judge composes their evidence. This makes every ruling independently reproducible and prevents
a compound actor from laundering a failure into a pass.

**Mapping to executable checks.** The VAD Verifier atoms are realized by the assertion-bearing tests in
`tests/vendor-adapters/final-security-remediation.test.ts` (each test = one or more VAD atoms). The
Judges are realized by (a) `npm run check` producing a green suite from clean source, and (b) an
independent human/CI reviewer who has not implemented the remediation. Until JUDGE-FINAL runs against an
independently produced build, the remediation status is **NOT ACCEPTED** by construction — see the
Proof of Work.
