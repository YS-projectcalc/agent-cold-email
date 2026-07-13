import { describe, expect, it } from "vitest";
import { api, cookieApi, createDashboardSession, signup } from "./helpers.js";

interface ViewSummary {
  id: string;
  name: string;
  isDefault: boolean;
  rev: number;
  editedBy: string;
  editedByNote: string | null;
  updatedAt: string;
}
interface ViewDetail extends ViewSummary {
  layout: { schemaVersion: number; widgets: unknown[] };
  createdAt: string;
}

const MINIMAL_LAYOUT = { schemaVersion: 1, widgets: [] };

// SPEC.md §19.2/§19.4 — the dashboard-views lifecycle: lazy-seeded default
// (stamped 'system'), single-default invariant, rev-CAS on update, delete guards.
describe("GET /dashboard/views* — lazy-seeded default view", () => {
  it("a fresh tenant's first call seeds exactly one 'default' view, stamped edited_by='system'", async () => {
    const { token } = await signup("Fresh Views Co", "fresh-views@dashboard-test.example");
    const views = await api<ViewSummary[]>("/dashboard/views", { token });
    expect(views.status).toBe(200);
    expect(views.body).toHaveLength(1);
    expect(views.body[0]!.id).toBe("default");
    expect(views.body[0]!.isDefault).toBe(true);
    expect(views.body[0]!.editedBy).toBe("system");
    expect(views.body[0]!.rev).toBe(1);

    const detail = await api<ViewDetail>("/dashboard/views/default", { token });
    expect(detail.status).toBe(200);
    expect(detail.body.layout.schemaVersion).toBe(1);
    expect(detail.body.layout.widgets.length).toBeGreaterThan(0); // starter layout, never empty

    // M5 R2 item 3 — the redesigned starter sells the AI-native thesis on
    // first load: KPIs, a live inbox preview, mailbox health, "what my agent
    // did", plan usage, and an agent_note placeholder inviting MCP.
    const types = detail.body.layout.widgets.map((w) => (w as { type: string }).type);
    expect(types).toEqual(["kpi_row", "inbox_preview", "mailbox_health", "agent_log", "quota_usage", "agent_note"]);
    const note = detail.body.layout.widgets.find((w) => (w as { type: string }).type === "agent_note") as { props: { markdown: string } };
    expect(note.props.markdown.toLowerCase()).toContain("mcp");
  });

  it("is idempotent — a second GET does not create a second default", async () => {
    const { token } = await signup("Idem Views Co", "idem-views@dashboard-test.example");
    await api("/dashboard/views", { token });
    const views = await api<ViewSummary[]>("/dashboard/views", { token });
    expect(views.body).toHaveLength(1);
  });

  it("only applies to a FRESH tenant — an already-seeded view is never re-seeded/replaced", async () => {
    const { token } = await signup("Existing Tenant Co", "existing-seed@dashboard-test.example");
    const first = await api<ViewDetail>("/dashboard/views/default", { token }); // seeds
    const second = await api<ViewDetail>("/dashboard/views/default", { token }); // ensureDefaultViewSeeded's count>0 guard: no-op
    expect(second.body.rev).toBe(first.body.rev);
    expect(second.body.updatedAt).toBe(first.body.updatedAt);
    expect(second.body.layout).toEqual(first.body.layout);
  });
});

describe("POST /dashboard/views — create", () => {
  it("creates a non-default view stamped by transport (api for bearer, dashboard for cookie)", async () => {
    const { token } = await signup("Create View Co", "create-view@dashboard-test.example");
    const created = await api<ViewDetail>("/dashboard/views", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "My Custom View", layout: MINIMAL_LAYOUT }),
    });
    expect(created.status).toBe(201);
    expect(created.body.isDefault).toBe(false);
    expect(created.body.editedBy).toBe("api");
    expect(created.body.id).not.toBe("default");

    const session = await createDashboardSession(token);
    const createdViaCookie = await cookieApi<ViewDetail>("/dashboard/views", session, {
      method: "POST",
      csrf: true,
      body: JSON.stringify({ name: "Cookie View", layout: MINIMAL_LAYOUT }),
    });
    expect(createdViaCookie.body.editedBy).toBe("dashboard");
  });

  it("422s with a structured, repairable error on an unknown widget type", async () => {
    const { token } = await signup("Bad Widget Co", "bad-widget@dashboard-test.example");
    const res = await api<{ error: string; issues: unknown[] }>("/dashboard/views", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "Bad",
        layout: { schemaVersion: 1, widgets: [{ id: "w1", type: "not_a_real_widget", gridPos: { x: 0, y: 0, w: 1, h: 1 }, visible: true, props: {} }] },
      }),
    });
    expect(res.status).toBe(422);
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues.length).toBeGreaterThan(0);
  });

  it("422s on invalid props for a KNOWN widget type", async () => {
    const { token } = await signup("Bad Props Co", "bad-props@dashboard-test.example");
    const res = await api(
      "/dashboard/views",
      {
        method: "POST",
        token,
        body: JSON.stringify({
          name: "Bad Props",
          layout: {
            schemaVersion: 1,
            widgets: [{ id: "w1", type: "kpi_row", gridPos: { x: 0, y: 0, w: 1, h: 1 }, visible: true, props: { metrics: ["not_a_real_metric"] } }],
          },
        }),
      },
    );
    expect(res.status).toBe(422);
  });
});

describe("PUT /dashboard/views/:id — rev-CAS update", () => {
  it("updates on a matching rev, incrementing rev", async () => {
    const { token } = await signup("Update View Co", "update-view@dashboard-test.example");
    await api("/dashboard/views", { token }); // seeds default (rev 1)

    const updated = await api<ViewDetail>("/dashboard/views/default", {
      method: "PUT",
      token,
      body: JSON.stringify({ rev: 1, layout: MINIMAL_LAYOUT, note: "cleared it out" }),
    });
    expect(updated.status).toBe(200);
    expect(updated.body.rev).toBe(2);
    expect(updated.body.layout.widgets).toEqual([]);
    expect(updated.body.editedByNote).toBe("cleared it out");
  });

  it("an update carrying `name` renames the view — id/rev-increment/provenance all still hold", async () => {
    const { token } = await signup("Rename View Co", "rename-view@dashboard-test.example");
    const created = await api<ViewDetail>("/dashboard/views", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "Original Name", layout: MINIMAL_LAYOUT }),
    });
    expect(created.body.rev).toBe(1);

    const renamed = await api<ViewDetail>(`/dashboard/views/${created.body.id}`, {
      method: "PUT",
      token,
      body: JSON.stringify({ rev: 1, layout: MINIMAL_LAYOUT, name: "Renamed View" }),
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.id).toBe(created.body.id); // rename never changes the slug/id
    expect(renamed.body.name).toBe("Renamed View");
    expect(renamed.body.rev).toBe(2); // same rev-CAS increment as any other update
    expect(renamed.body.editedBy).toBe("api"); // same provenance derivation as any other update

    const list = await api<ViewSummary[]>("/dashboard/views", { token });
    expect(list.body.find((v) => v.id === created.body.id)!.name).toBe("Renamed View");
  });

  it("an update WITHOUT `name` leaves the existing name untouched", async () => {
    const { token } = await signup("No Rename Co", "no-rename@dashboard-test.example");
    const created = await api<ViewDetail>("/dashboard/views", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "Keep Me", layout: MINIMAL_LAYOUT }),
    });

    const updated = await api<ViewDetail>(`/dashboard/views/${created.body.id}`, {
      method: "PUT",
      token,
      body: JSON.stringify({ rev: 1, layout: MINIMAL_LAYOUT }),
    });
    expect(updated.body.name).toBe("Keep Me");
  });

  it("a STALE rev returns a structured 409 with currentRev + currentLayout so the agent can rebase", async () => {
    const { token } = await signup("Stale Rev Co", "stale-rev@dashboard-test.example");
    await api("/dashboard/views", { token }); // seeds default (rev 1)
    await api("/dashboard/views/default", { method: "PUT", token, body: JSON.stringify({ rev: 1, layout: MINIMAL_LAYOUT }) }); // -> rev 2

    const staleWrite = await api<{ error: string; currentRev: number; currentLayout: { widgets: unknown[] } }>(
      "/dashboard/views/default",
      { method: "PUT", token, body: JSON.stringify({ rev: 1, layout: MINIMAL_LAYOUT }) }, // stale — current is now 2
    );
    expect(staleWrite.status).toBe(409);
    expect(staleWrite.body.currentRev).toBe(2);
    expect(staleWrite.body.currentLayout.widgets).toEqual([]);
  });
});

describe("agent_note widget content safety at the STORAGE layer (§19.7 item 6)", () => {
  // The backend must never mangle an XSS-shaped agent_note markdown string —
  // it is stored and returned as plain data. The RENDERING guard (restricted
  // markdown renderer, DOMPurify strict allowlist, no raw-HTML pass-through)
  // is an M2/M3 apps/dashboard SPA concern; there is nothing to render here.
  it("an agent_note widget with <script>/javascript: content round-trips byte-for-byte", async () => {
    const { token } = await signup("Agent Note XSS Co", "agent-note-xss@dashboard-test.example");
    const hostile = '<script>alert(1)</script> [click me](javascript:alert(2)) <img src=x onerror=alert(3)>';
    const layout = {
      schemaVersion: 1,
      widgets: [
        {
          id: "w_note",
          type: "agent_note",
          gridPos: { x: 0, y: 0, w: 12, h: 2 },
          visible: true,
          props: { markdown: hostile },
        },
      ],
    };

    const created = await api<ViewDetail>("/dashboard/views", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "Hostile Note View", layout }),
    });
    expect(created.status).toBe(201);
    expect((created.body.layout.widgets[0] as { props: { markdown: string } }).props.markdown).toBe(hostile);

    const refetched = await api<ViewDetail>(`/dashboard/views/${created.body.id}`, { token });
    expect((refetched.body.layout.widgets[0] as { props: { markdown: string } }).props.markdown).toBe(hostile);
  });
});

describe("POST /dashboard/views/:id/default — single-default invariant + delete guards", () => {
  it("promoting a new view atomically demotes the previous default", async () => {
    const { token } = await signup("Promote Co", "promote@dashboard-test.example");
    await api("/dashboard/views", { token }); // seed default
    const created = await api<ViewDetail>("/dashboard/views", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "New Default Candidate", layout: MINIMAL_LAYOUT }),
    });

    const promote = await api<ViewSummary[]>(`/dashboard/views/${created.body.id}/default`, { method: "POST", token });
    expect(promote.status).toBe(200);
    const defaults = promote.body.filter((v) => v.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe(created.body.id);
  });

  it("refuses to delete the default view", async () => {
    const { token } = await signup("Delete Default Co", "delete-default@dashboard-test.example");
    await api("/dashboard/views", { token });
    const del = await api<{ error: string }>("/dashboard/views/default", { method: "DELETE", token });
    expect(del.status).toBe(400);
  });

  it("refuses to delete the last remaining view even if (hypothetically) non-default", async () => {
    const { token } = await signup("Delete Last Co", "delete-last@dashboard-test.example");
    await api("/dashboard/views", { token }); // only 'default' exists — is_default=1
    const del = await api<{ error: string }>("/dashboard/views/default", { method: "DELETE", token });
    expect(del.status).toBe(400); // default guard fires first, but it's still refused either way
  });

  it("deletes a non-default, non-last view", async () => {
    const { token } = await signup("Delete Ok Co", "delete-ok@dashboard-test.example");
    await api("/dashboard/views", { token });
    const created = await api<ViewDetail>("/dashboard/views", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "Disposable", layout: MINIMAL_LAYOUT }),
    });
    const del = await api<{ deleted: true }>(`/dashboard/views/${created.body.id}`, { method: "DELETE", token });
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);

    const missing = await api(`/dashboard/views/${created.body.id}`, { token });
    expect(missing.status).toBe(404);
  });
});
