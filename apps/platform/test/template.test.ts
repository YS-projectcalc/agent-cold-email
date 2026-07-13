import { describe, expect, it } from "vitest";
import { renderTemplate } from "../src/engine/template.js";

describe("renderTemplate — {{firstName}}/{{company}} substitution", () => {
  it("substitutes both known tokens, including repeats", () => {
    expect(renderTemplate("Hi {{firstName}}, re: {{company}}. Loving {{company}} so far?", { firstName: "Ada", company: "Analytical Engines" })).toBe(
      "Hi Ada, re: Analytical Engines. Loving Analytical Engines so far?",
    );
  });

  it("leaves an unknown {{token}} verbatim rather than silently dropping it", () => {
    expect(renderTemplate("Hi {{firstName}}, {{unknownToken}} stays put.", { firstName: "Grace", company: "Compiler Corp" })).toBe(
      "Hi Grace, {{unknownToken}} stays put.",
    );
  });

  it("a template with no tokens passes through unchanged", () => {
    expect(renderTemplate("Just checking back in.", { firstName: "Grace", company: "Compiler Corp" })).toBe("Just checking back in.");
  });

  it("tolerates internal whitespace inside the braces ({{ firstName }})", () => {
    expect(renderTemplate("Hi {{ firstName }}!", { firstName: "Morgan", company: "Reply Co" })).toBe("Hi Morgan!");
  });
});
