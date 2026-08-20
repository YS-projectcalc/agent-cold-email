---
name: cursor-restart-on-full-page-pins-the-rotation
description: A keyset-paging sweep cursor whose "restart" predicate is `covered >= page.length` can never advance past page one — a FULL page and the LAST page are indistinguishable by that test, so every item past the first page is never swept again.
metadata:
  type: project
---

I shipped this and a test caught it (ColdStart wave B, `admin/tenant-slice.ts`).

Writing a rotating sweep over a keyset page, the commit looked obviously right:

```ts
const covered = Math.min(visitedByEveryLeg, slice.ids.length);
const next = covered >= slice.ids.length ? null : slice.ids[covered - 1]; // null = restart
```

`null` means "start the next rotation at the head". But `covered >= ids.length`
is TRUE for a page that was fully swept AND for the tail page — and the common
case is the full page. So every tick re-read the same first page and no tenant
past `LIMIT` was ever swept again. The bound was real; the rotation was fake.

**The distinguishing fact is not in the page.** "This page is done" is
`covered === ids.length`; "the ROTATION is done" additionally needs
`ids.length >= total` — a fact only a separate `COUNT(*)` (or a short page)
can supply:

```ts
const complete = slice.complete && covered >= slice.ids.length;
const next = covered === 0 || complete ? null : slice.ids[covered - 1];
```

**How to apply:** any cursor whose sentinel means "wrap", check what actually
proves the wrap. Same shape as [[insert-only-ask-vs-shrinking-live-set]]: a
predicate reading one side of a comparison as if it carried both.

**What caught it:** an EFFECT-level test — run three ticks at 3x the page size
and assert the union of swept ids equals every id — not a shape test on the
returned cursor. A shape test would have agreed with the bug. Related:
[[recommendation-must-be-executed-not-shape-checked]].
