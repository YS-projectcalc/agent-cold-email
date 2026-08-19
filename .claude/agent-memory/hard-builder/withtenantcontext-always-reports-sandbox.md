---
name: withtenantcontext-always-reports-sandbox
description: test/helpers.ts's withTenantContext builds its OWN adapter bundle with no inboxKitConfig, so `ctx.adapters.kind` is 'sandbox' no matter what env says — ask the DO's buildAdapters()
metadata:
  type: reference
---

`withTenantContext(tenantId, fn)` (apps/platform/test/helpers.ts) constructs its
context by calling `createVendorAdapters(plan, clock, activated)` — with NO
`engineConfig`, NO `inboxKitConfig` and NO `registrarArming`. Since
`useSandbox = isDemoOrFree || !activated || !inboxKitConfig`, the bundle it hands
back is ALWAYS `kind: 'sandbox'`, however the env is armed.

So an assertion like `expect(ctx.adapters.kind).toBe('real')` through this helper
fails on correctly-armed fixtures, and — worse in the other direction — a test
that exercises engine code through it is exercising the sandbox ports while the
HTTP path under test uses real ones.

**To ask what the PRODUCTION path would use**, call the DO's own builder:

```ts
await runInDurableObject(tenantStub(tenantId), (instance) => {
  const bundle = (instance as unknown as { buildAdapters(): { kind: string } }).buildAdapters();
  expect(bundle.kind).toBe("real");
});
```

(`test/registrar-arming.test.ts` uses this idiom via a `TenantDOWithBuildAdapters`
interface.) `withTenantContext` stays the right tool for driving an `engine/*.ts`
function directly with an injected dependency — just never for a question about
which bundle production would select.

Related: [[coldstart-vitest-binding-and-d1-isolation-gotchas]],
[[recommendation-must-be-executed-not-shape-checked]].
