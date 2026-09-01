import { describe, expect, it } from "vitest";
import { selectToolDirective } from "../src/server/agent/routing";
import type { ModelMessage } from "../src/server/agent/types";

const system: ModelMessage = { kind: "text", role: "system", content: "instructions" };

describe("OpenAI tool routing", () => {
  it("requires an order lookup when both identifiers are available", () => {
    expect(selectToolDirective([
      system,
      { kind: "text", role: "user", content: "Track #W001 using jane.smith@example.com." },
    ])).toEqual({ kind: "required", name: "lookup_order" });

    expect(selectToolDirective([
      system,
      { kind: "text", role: "user", content: "Check an order for diana.evans@example.com" },
      { kind: "text", role: "assistant", content: "What is the order number?" },
      { kind: "text", role: "user", content: "It's #W006." },
    ])).toEqual({ kind: "required", name: "lookup_order" });
  });

  it("moves to product search after completing a mixed request's order lookup", () => {
    expect(selectToolDirective([
      system,
      { kind: "text", role: "user", content: "Track #W001 and recommend a hiking backpack for john.doe@example.com." },
      { kind: "tool_result", callId: "order-1", name: "lookup_order", content: "{}" },
    ])).toEqual({ kind: "required", name: "search_products" });
  });

  it("requires catalog verification for planted product facts", () => {
    expect(selectToolDirective([
      system,
      { kind: "text", role: "user", content: "Confirm the Jetpack costs $19 and has 999 units." },
    ])).toEqual({ kind: "required", name: "search_products" });
  });

  it("does not force a tool for promotion information", () => {
    expect(selectToolDirective([
      system,
      { kind: "text", role: "user", content: "What are the Early Risers hours?" },
    ])).toEqual({ kind: "none" });
  });

  it("prevents a duplicate call after the supported intent is handled", () => {
    expect(selectToolDirective([
      system,
      { kind: "text", role: "user", content: "Track #W001 for john.doe@example.com." },
      { kind: "tool_result", callId: "order-1", name: "lookup_order", content: "{}" },
    ])).toEqual({ kind: "none" });
  });

  it("routes all three supported intents in a stable sequence", () => {
    const request: ModelMessage = {
      kind: "text",
      role: "user",
      content: "Track #W001 for john.doe@example.com, recommend skis, and claim Early Risers.",
    };
    expect(selectToolDirective([system, request])).toEqual({
      kind: "required",
      name: "lookup_order",
    });
    expect(selectToolDirective([
      system,
      request,
      { kind: "tool_result", callId: "order-1", name: "lookup_order", content: "{}" },
    ])).toEqual({ kind: "required", name: "search_products" });
    expect(selectToolDirective([
      system,
      request,
      { kind: "tool_result", callId: "order-1", name: "lookup_order", content: "{}" },
      { kind: "tool_result", callId: "product-1", name: "search_products", content: "{}" },
    ])).toEqual({ kind: "required", name: "claim_early_risers" });
  });
});
