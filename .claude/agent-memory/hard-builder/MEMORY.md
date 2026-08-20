# hard-builder memory index

> One line per memory. The fix recipes, repro shapes and revert-proofs live in the linked files — open the file before acting on a hook.
- [changed-detail-escape-storms-on-alternation](changed-detail-escape-storms-on-alternation.md) — ⚠️ escaping a cooldown on a CHANGED detail storms on alternation (13 emails/13 ticks); needs a per-episode announced SET.
- [dedup-key-is-also-spent-at-the-vendor](dedup-key-is-also-spent-at-the-vendor.md) — ⚠️ shrinking a LOCAL dedup window is a no-op when the vendor caches the key; fix the KEY (durable epoch, not a clock bucket).
- [sweep-prescribed-key-needs-component-provenance-check](sweep-prescribed-key-needs-component-provenance-check.md) — ⚠️ `receivedAt` is POLL time; provenance-check every component of a prescribed key.
- [two-waves-fight-over-one-column-split-it](two-waves-fight-over-one-column-split-it.md) — a sweep-vs-design clash usually means one column carries two facts; split it.
- [total-count-assertion-proxies-per-resource-invariant](total-count-assertion-proxies-per-resource-invariant.md) — ⚠️ a TOTAL-call-count guard as PER-RESOURCE proxy reads P0 once isolation stops the early abort.
- [wall-clock-rotation-makes-order-assertions-periodic-flakes](wall-clock-rotation-makes-order-assertions-periodic-flakes.md) — `rotationOffset` flips list order every cron period — fixed-order asserts are wall-clock flakes.

## Failure mechanisms (check before diagnosing a hard case)
- [seam-carries-the-claim-and-drops-the-money-field](seam-carries-the-claim-and-drops-the-money-field.md) — ⚠️ a params/prose no-disagree seam still shipped `effect: null` on bill-raising calls; guard the DERIVATION, not the seam.
- [resolution-predicate-inherits-its-reason-sets-coverage](resolution-predicate-inherits-its-reason-sets-coverage.md) — ⚠️ "no reason in S is owed" used as "RESOLVED" silences every emit-state S doesn't cover.
- [destructive-rederivation-outruns-the-grace-it-races](destructive-rederivation-outruns-the-grace-it-races.md) — ⚠️ a 5-min sweep destroys a record 6x before a 30-min grace can contradict it.
- [insert-only-column-null-for-pre-column-population](insert-only-column-null-for-pre-column-population.md) — ⚠️ CUSTOMER P0 08-19: `addColumnIfMissing` + INSERT-only writer = permanently NULL for pre-column rows.
- [bookkeeping-write-outside-try-fails-the-call](bookkeeping-write-outside-try-fails-the-call.md) — ⚠️ a bare liveness stamp makes bookkeeping a precondition of all 28 tools.
- [staleness-exclusion-needs-severity-scope-not-just-kind](staleness-exclusion-needs-severity-scope-not-just-kind.md) — "re-derivable" is (kind × severity) — the same kind's `operator_pending` form is a LIVE blocker.
- [two-valued-grade-for-a-three-valued-refusal](two-valued-grade-for-a-three-valued-refusal.md) — ⚠️ THE 08-18 CLASS: a boolean `retryable` can't say "operator clears it, then retry works".
- [vendor-prepaid-wallet-exhaustion-reads-as-permanent](vendor-prepaid-wallet-exhaustion-reads-as-permanent.md) — ⚠️ P0 08-18: an empty InboxKit wallet 4xx's every money-out call, graded permanent.
- [fixture-born-with-the-code-restates-its-premise](fixture-born-with-the-code-restates-its-premise.md) — ⚠️ a fixture authored in the SAME commit as its parser tests the code's premise, not the vendor's.
- [operator-read-scoped-by-key-prefix-reports-empty-as-truth](operator-read-scoped-by-key-prefix-reports-empty-as-truth.md) — a key-prefix-filtered operator read: `requestIdempotency:[]` never meant "no claim."
- [confirmation-guard-deletes-one-shot-signals](confirmation-guard-deletes-one-shot-signals.md) — ⚠️ a debounce at a SHARED alert choke point delays a re-sampled check but DELETES a one-shot event report.
- [gate-waits-on-state-the-gated-action-produces](gate-waits-on-state-the-gated-action-produces.md) — ⚠️ a readiness gate awaiting state only the gated action produces is a DEADLOCK.
- [code-with-no-production-driver-passes-every-test](code-with-no-production-driver-passes-every-test.md) — ⚠️ a feature whose only caller is an entry point production never invokes is 100% green and 100% dead.
- [vendor-cancel-needs-marker-and-attempt-cap](vendor-cancel-needs-marker-and-attempt-cap.md) — a one-shot vendor action fired off a COMPUTED transition re-fires every tick without a persisted marker.
- [guards-inline-in-a-loop-are-not-a-policy](guards-inline-in-a-loop-are-not-a-policy.md) — governance written inline in a batch loop is unenforced on every other path to the same effect.
- [coldstart-per-tick-recompute-clobbers-control-state](coldstart-per-tick-recompute-clobbers-control-state.md) — a per-tick refresh that recomputes a column wipes any control-loop override on that same column.
- [coldstart-suspend-auth-split-do-vs-d1](coldstart-suspend-auth-split-do-vs-d1.md) — DO `tenant_profile.status='suspended'` does NOT lock the token; flip both or the tenant re-provisions.
- [backtick-inside-template-literal-sql](backtick-inside-template-literal-sql.md) — a backtick inside a backtick-delimited SQL template literal (even in a comment) ends the string → misleading TS1005 errors.
- [sandbox-port-masks-real-server-contract](sandbox-port-masks-real-server-contract.md) — the sandbox EmailPort hides 4 real-server obligations; validate against a real server first.
- [async-tally-reset-on-triggering-action](async-tally-reset-on-triggering-action.md) — resetting a counter on the same action that async-feeds it makes the threshold unreachable.
- [dsn-arf-fields-live-in-mime-subparts](dsn-arf-fields-live-in-mime-subparts.md) — DSN/ARF fields live in MIME SUB-PARTS; an RFC 5322 top-level header parser silently returns empty → whole-source line-anchored scan.
- [persist-before-confirm-cross-boundary](persist-before-confirm-cross-boundary.md) — ⚠️ CLASS: state advanced BEFORE the cross-boundary effect is confirmed. 5 members + the spend-side mirror.
- [json-store-corrupt-catchall-silent-empty](json-store-corrupt-catchall-silent-empty.md) — a JSON store whose loader catches ALL errors→empty drops state on corruption, overwrites the only copy.
- [period-keyed-counter-for-persistent-resource](period-keyed-counter-for-persistent-resource.md) — CLASS both ways: a per-period counter gating a persistent resource over-allocates; a lifetime counter never resets.
- [compaction-snapshot-must-carry-inflight-state](compaction-snapshot-must-carry-inflight-state.md) — a compaction snapshot that discards its source log must serialize every UN-RESOLVED entry.
- [adapter-selected-from-column-before-same-request-update](adapter-selected-from-column-before-same-request-update.md) — a port baked from a persisted column at request-entry the SAME request later UPDATEs is one-call-stale.
- [half-a-vendor-contract-invoked-on-the-other-half](half-a-vendor-contract-invoked-on-the-other-half.md) — ⚠️ the customer-P0: an adapter implementing one half of a two-half vendor contract invoked on the other half.
- [rpc-boundary-strips-class-identity](rpc-boundary-strips-class-identity.md) — ⚠️ an error thrown in the DO reaches the Worker with NO prototype, so `instanceof` is FALSE at the HTTP surface; branch on `err.name`.
- [merge-of-prerefactor-lane-reverts-sibling-fix](merge-of-prerefactor-lane-reverts-sibling-fix.md) — taking the incoming side of a moved-function conflict silently REVERTS the refactor lane's fix inside it.
- [customer-safe-translator-gated-on-error-shape](customer-safe-translator-gated-on-error-shape.md) — a sanitizing translator behind a shape predicate leaks vendor identity via a raw `String(err)` fallthrough.
- [false-recovery-disarms-cooldown-dedup](false-recovery-disarms-cooldown-dedup.md) — clearing on the vendor ACCEPTING a remedy disarms the cooldown; clear only on a proven goal state.
- [fixture-decorates-vendor-owned-object](fixture-decorates-vendor-owned-object.md) — ⚠️ OUR field on a VENDOR-MINTED fixture restates the parser's premise; 1271 green, 2 billing lanes dead.
- [guard-scoped-wider-than-the-state-it-protects](guard-scoped-wider-than-the-state-it-protects.md) — ⚠️ (I shipped it): a dedup guard keyed globally over independent state machines silences them all.
- [completion-pass-must-recheck-ordering](completion-pass-must-recheck-ordering.md) — a "finish crashed work" pass is a SECOND write path; re-apply every pre-effect guard.
- [sandbox-fallback-masks-a-missing-activation-gate](sandbox-fallback-masks-a-missing-activation-gate.md) — ⚠️ a missing gate degrading to a SANDBOX adapter makes "no vendor call" true on the broken code too.
- [polling-check-error-is-indistinguishable-from-negative](polling-check-error-is-indistinguishable-from-negative.md) — a poll whose ERROR looks like its NEGATIVE reports "all clear" while broken.
- [fail-loud-throw-after-billed-vendor-call](fail-loud-throw-after-billed-vendor-call.md) — a new throw AFTER a billed vendor call but BEFORE its durable marker becomes a deterministic re-charge loop if graded retryable.
- [refusal-path-added-to-claimed-record-table](refusal-path-added-to-claimed-record-table.md) — a new REFUSAL path after a claim-first dedup INSERT creates "recorded but not applied" rows.
- [exemption-inherits-none-of-the-guards-reasoning](exemption-inherits-none-of-the-guards-reasoning.md) — ⚠️ an exemption carved for the cross-OBJECT case exempts the same-OBJECT reverse order too → a terminal state.
- [caller-side-effect-gated-on-callee-result-field](caller-side-effect-gated-on-callee-result-field.md) — a caller-side flip gated on a result field stops firing once the callee applies the effect but omits the field.
- [return-type-destroys-the-terminal-distinction](return-type-destroys-the-terminal-distinction.md) — ⚠️ a port whose return type cannot say DEAD reports a terminal vendor state as its benign not-yet.
- [idempotency-replays-a-non-terminal-outcome-forever](idempotency-replays-a-non-terminal-outcome-forever.md) — ⚠️ recording any RETURN as replayable makes a 202 an eternal no-op; replay only if TERMINAL.
- [anchor-stamped-before-the-read-defeats-its-own-bound](anchor-stamped-before-the-read-defeats-its-own-bound.md) — ⚠️ an age bound whose anchor is stamped by the call that reads it measures ~0 forever for the legacy NULL population.
- [classifier-cannot-see-an-undiscriminated-return](classifier-cannot-see-an-undiscriminated-return.md) — ⚠️ a result-SHAPE classifier is blind to any branch returning the success shape.
- [deleted-mechanism-leaves-its-prose-and-its-sentinel](deleted-mechanism-leaves-its-prose-and-its-sentinel.md) — replacing a mechanism leaves its customer prose AND a sentinel re-committing it.
- [vendor-200-with-error-true-reads-as-absent](vendor-200-with-error-true-reads-as-absent.md) — InboxKitClient rejects only on non-2xx, so a 200 `{error:true}` reads as "vendor holds nothing."
- [error-isolation-refactor-voids-throw-dependent-invariants](error-isolation-refactor-voids-throw-dependent-invariants.md) — ⚠️ fail-fast→per-item isolation voids every invariant the throw justified.
- [fix-shape-differs-when-decider-and-sender-split-across-rpc](fix-shape-differs-when-decider-and-sender-split-across-rpc.md) — ⚠️ a sweep row naming 3 sites got closed at 1; DO-decides/Worker-sends needs two-phase decide/commit.
- [nonterminal-retry-drives-a-relative-destructive-op](nonterminal-retry-drives-a-relative-destructive-op.md) — ⚠️ a correct NON-TERMINAL verdict hands an unbounded retry to a RELATIVE destructive op.
- [orphan-detection-blind-to-the-row-never-created](orphan-detection-blind-to-the-row-never-created.md) — ⚠️ stuck-row orphan checks can't see the row NEVER created; detect via paid-commitment-vs-state.
- [absent-field-means-opposite-things-on-read-and-write](absent-field-means-opposite-things-on-read-and-write.md) — ⚠️ CONFIRMED LIVE: `registerDomains` absent means opposite things on WRITE vs READ; 503s + pages the founder.
- [emitter-writes-into-the-set-that-keys-its-own-dedup](emitter-writes-into-the-set-that-keys-its-own-dedup.md) — ⚠️ a one-shot keyed on a derived SET re-arms forever once its own emission joins that set.
- [shared-primitive-caveat-wired-to-one-consumer](shared-primitive-caveat-wired-to-one-consumer.md) — ⚠️ THIRD INSTANCE: a skip/exclusion lives at the consumer that noticed it, not in the shared primitive.
- [ctx-clock-anchors-are-virtual-domain-forever](ctx-clock-anchors-are-virtual-domain-forever.md) — ⚠️ clock-migration shifted exactly SIX columns; an age bound on any OTHER `ctx.clock` column goes NEGATIVE, silently.
- [relaxing-a-guarantee-orphans-its-silent-consumers](relaxing-a-guarantee-orphans-its-silent-consumers.md) — ⚠️ relaxing a zod refinement broke a write path + port constructor that RELIED on it, unnamed.
- [recommendation-must-be-executed-not-shape-checked](recommendation-must-be-executed-not-shape-checked.md) — ⚠️ an emitted call must be RUN by its guard on the REAL bundle; a shape test can't see a missing field.
- [insert-only-ask-vs-shrinking-live-set](insert-only-ask-vs-shrinking-live-set.md) — ⚠️ an INSERT-only ask minus a SHRINKING live set reads every deliberate removal as permanent failure. Sibling: [[insert-only-column-null-for-pre-column-population]].
- [remedy-computed-in-different-coordinates-than-the-defect](remedy-computed-in-different-coordinates-than-the-defect.md) — ⚠️ params from one function + claim from another = a no-op-forever remedy AND a domain-buying escalation.

## Test-env gotchas (ColdStart apps/platform vitest)
- [worktree-without-node-modules-resolves-to-main](worktree-without-node-modules-resolves-to-main.md) — ⚠️ a `.claude/worktrees/*` lane has NO node_modules, so `@coldstart/shared` resolves to MAIN.
- [idempotency-replay-hides-the-path-under-test](idempotency-replay-hides-the-path-under-test.md) — a crash fixture built by running the saga to SUCCESS then corrupting a row never re-enters the code under test.
- [coldstart-vitest-binding-and-d1-isolation-gotchas](coldstart-vitest-binding-and-d1-isolation-gotchas.md) — bindings ARE bound in the vitest env; `env.DB` writes are NOT rolled back per-test.
- [withtenantcontext-always-reports-sandbox](withtenantcontext-always-reports-sandbox.md) — `withTenantContext` builds its own bundle with no inboxKitConfig, so `adapters.kind` is ALWAYS 'sandbox'.
- [do-constructor-and-query-order-test-gotchas](do-constructor-and-query-order-test-gotchas.md) — `evictDurableObject` is the only real DO-CONSTRUCTOR test; un-ORDER-BY'd queries return INDEX order.
- [vitest-pool-workers-ambient-devvars-leak](vitest-pool-workers-ambient-devvars-leak.md) — the pool auto-loads `apps/*/.dev.vars` and injects every key — a dev's ambient real secret flips a behavior gate.

## Build techniques
- [pinned-exemption-beats-a-skip-when-scope-is-not-yours](pinned-exemption-beats-a-skip-when-scope-is-not-yours.md) — a guard reddening on an out-of-brief member: ASSERT the violation at its exact sites so the fix reddens the pin.
- [revert-proof-must-revert-the-importer-too](revert-proof-must-revert-the-importer-too.md) — ⚠️ reverting only the fix file deletes an export its still-modified consumer imports; the RED leg proves nothing.
- [failing-by-construction-env-coverage-guard](failing-by-construction-env-coverage-guard.md) — enforce "a new env binding must wire into isRealSpendArmed" with a test that `?raw`-parses env.ts source.
- [coldstart-engine-crash-injection-idiom](coldstart-engine-crash-injection-idiom.md) — deterministic engine crash tests via a faulty SendLog + discard-and-rebuild-from-disk; engine vitest's ~30s ESM transform is not a hang.
- [declared-content-length-cap-is-opt-out](declared-content-length-cap-is-opt-out.md) — ⚠️ a body cap reading DECLARED Content-Length is opt-out (chunked → NaN → skipped).
- [root-build-dirties-committed-dashboard-assets](root-build-dirties-committed-dashboard-assets.md) — root `npm run build` rewrites COMMITTED dashboard asset hashes; undo with `git show HEAD:<p> > <p>`.
- [loop-isolation-tripwire-flags-any-sql-write-loop](loop-isolation-tripwire-flags-any-sql-write-loop.md) — a new for-loop containing `ctx.sql.exec` reddens the FULL platform suite only; build ONE multi-row INSERT instead.

## Build patterns / gotchas (ColdStart engine)
- [stripe-percent-coupon-prorates-at-unit-level](stripe-percent-coupon-prorates-at-unit-level.md) — a percent coupon bakes the discount INTO the proration line, so `total != subtotal×(1−pct)`.
- [coldstart-authed-route-needs-path-pattern-and-zod-default-output-required](coldstart-authed-route-needs-path-pattern-and-zod-default-output-required.md) — a new authed route 500s until its path joins `AUTHED_PATH_PATTERNS`.
- [coldstart-mailcomposer-single-builder-for-transports](coldstart-mailcomposer-single-builder-for-transports.md) — new send transports must reuse nodemailer's MailComposer as the ONE raw-message builder.
- [cast-built-fixture-hides-a-new-required-field](cast-built-fixture-hides-a-new-required-field.md) — `as unknown as T` fixtures are invisible to tsc when T grows a field.
- [coldstart-env-example-gitignored-and-header-folding](coldstart-env-example-gitignored-and-header-folding.md) — `.env.example` is gitignored by `.env.*`; long MIME headers fold, so assert fold-tolerantly.
