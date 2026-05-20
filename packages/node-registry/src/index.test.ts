import { describe, expect, it } from "vitest";
import { checkNodeTypeCompatibility, createNodeRegistry, normalizeReusableNodeDefinition } from "./index.js";

describe("node registry", () => {
  it("registers reusable definitions by type", () => {
    const registry = createNodeRegistry([{ type: "custom.prompt", displayName: "Prompt", version: 1 }]);
    expect(registry.get("custom.prompt")).toMatchObject({ displayName: "Prompt" });
    registry.register({ type: "custom.router", displayName: "Router" });
    expect(registry.list()).toHaveLength(2);
  });

  it("normalizes code-backed definitions as worker-only metadata", () => {
    const definition = normalizeReusableNodeDefinition({ kind: "python-function", label: "Py", code: { kind: "python-function", module: "pkg.mod", functionName: "run" } });
    expect(definition).toMatchObject({ kind: "python-function", workerOnly: true, category: "action" });
  });

  it("reports incompatible handle and category changes", () => {
    const previous = normalizeReusableNodeDefinition({ kind: "router-rules", label: "Router", category: "router", outputs: [{ id: "yes" }, { id: "no" }] });
    const next = normalizeReusableNodeDefinition({ kind: "prompt-template", label: "Prompt", category: "action", outputs: [{ id: "out" }] });
    expect(checkNodeTypeCompatibility(previous, next).map((issue) => issue.code)).toEqual(expect.arrayContaining(["category-changed", "output-removed"]));
  });
});
