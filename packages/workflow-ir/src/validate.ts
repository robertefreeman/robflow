import type { EdgeDefinition, NodeDefinition, SchemaDefinition, ValidationIssue, ValidationResult, WorkflowDefinition } from "./types.js";

function issue(severity: ValidationIssue["severity"], code: ValidationIssue["code"], message: string, details: Omit<ValidationIssue, "severity" | "code" | "message"> = {}): ValidationIssue {
  return { severity, code, message, ...details };
}

function handleSet(handles: readonly { readonly id: string }[] | undefined): ReadonlySet<string> {
  return new Set((handles ?? []).map((handle) => handle.id));
}

function firstHandleSchema(handles: readonly { readonly id: string; readonly schema?: SchemaDefinition }[] | undefined, id: string | undefined): SchemaDefinition | undefined {
  if (id === undefined) return undefined;
  return handles?.find((handle) => handle.id === id)?.schema;
}

function typeSet(schema: SchemaDefinition | undefined): ReadonlySet<string> | undefined {
  if (schema === undefined) return undefined;
  return new Set(Array.isArray(schema.type) ? schema.type : [schema.type]);
}

function typeSetsOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const entry of left) {
    if (right.has(entry)) return true;
  }
  return false;
}

function isSchemaCompatible(source: SchemaDefinition | undefined, target: SchemaDefinition | undefined): boolean {
  if (source === undefined || target === undefined) return true;
  const sourceTypes = typeSet(source);
  const targetTypes = typeSet(target);
  if (sourceTypes !== undefined && targetTypes !== undefined && !typeSetsOverlap(sourceTypes, targetTypes)) return false;

  const targetRequires = target.required ?? [];
  if (targetRequires.length === 0) return true;
  const sourceProperties = source.properties ?? {};
  return targetRequires.every((property) => Object.prototype.hasOwnProperty.call(sourceProperties, property));
}

function configHas(config: Readonly<Record<string, unknown>> | undefined, path: string): boolean {
  const parts = path.split(".").filter(Boolean);
  let current: unknown = config;
  for (const part of parts) {
    if (typeof current !== "object" || current === null || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return false;
    }
    current = (current as Readonly<Record<string, unknown>>)[part];
  }
  return current !== undefined && current !== null && current !== "";
}

function requiredConfigPaths(node: NodeDefinition): readonly string[] {
  const explicit = node.requiredConfig ?? [];
  const inferred: string[] = [];
  if (node.runtime?.kind === "adk" && node.runtime.entrypoint === undefined) inferred.push("runtime.entrypoint");
  if (node.runtime?.model !== undefined) {
    if (node.runtime.model.provider.length === 0) inferred.push("runtime.model.provider");
    if (node.runtime.model.model.length === 0) inferred.push("runtime.model.model");
  }
  if (node.runtime?.tool !== undefined && node.runtime.tool.name.length === 0) inferred.push("runtime.tool.name");
  if (node.runtime?.memory !== undefined && node.runtime.memory.namespace.length === 0) inferred.push("runtime.memory.namespace");
  return [...explicit, ...inferred];
}

function nodeSatisfiesPath(node: NodeDefinition, path: string): boolean {
  if (path.startsWith("runtime.")) {
    const runtimeRecord = node.runtime as Readonly<Record<string, unknown>> | undefined;
    return configHas(runtimeRecord, path.replace(/^runtime\./, ""));
  }
  return configHas(node.config, path);
}

function adjacency(nodes: readonly NodeDefinition[], edges: readonly EdgeDefinition[]): Map<string, string[]> {
  const graph = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) graph.get(edge.source)?.push(edge.target);
  return graph;
}

function reachableFrom(startId: string, graph: ReadonlyMap<string, readonly string[]>): ReadonlySet<string> {
  const seen = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    for (const next of graph.get(id) ?? []) stack.push(next);
  }
  return seen;
}

function findCycles(nodes: readonly NodeDefinition[], graph: ReadonlyMap<string, readonly string[]>): readonly (readonly string[])[] {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];
  const cycles: string[][] = [];

  function visit(nodeId: string): void {
    visited.add(nodeId);
    inStack.add(nodeId);
    path.push(nodeId);

    for (const next of graph.get(nodeId) ?? []) {
      if (!visited.has(next)) {
        visit(next);
      } else if (inStack.has(next)) {
        const start = path.indexOf(next);
        cycles.push(path.slice(start));
      }
    }

    path.pop();
    inStack.delete(nodeId);
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) visit(node.id);
  }
  return cycles;
}

function cycleAllowed(cycle: readonly string[], byId: ReadonlyMap<string, NodeDefinition>): boolean {
  return cycle.some((nodeId) => {
    const node = byId.get(nodeId);
    return node?.category === "loop" && node.loop?.allowCycles === true;
  });
}

export function validateWorkflowDefinition(workflow: WorkflowDefinition): ValidationResult {
  const issues: ValidationIssue[] = [];
  const byId = new Map<string, NodeDefinition>();
  const edgeIds = new Set<string>();

  for (const node of workflow.nodes) {
    if (byId.has(node.id)) issues.push(issue("error", "duplicate-node-id", `Duplicate node id '${node.id}'.`, { nodeId: node.id }));
    byId.set(node.id, node);
  }

  for (const edge of workflow.edges) {
    if (edgeIds.has(edge.id)) issues.push(issue("error", "duplicate-edge-id", `Duplicate edge id '${edge.id}'.`, { edgeId: edge.id }));
    edgeIds.add(edge.id);
  }

  const starts = workflow.nodes.filter((node) => node.category === "start");
  if (starts.length === 0) issues.push(issue("error", "missing-start", "Workflow must contain exactly one start node."));
  if (starts.length > 1) issues.push(issue("error", "multiple-starts", "Workflow must contain exactly one start node."));
  const terminals = workflow.nodes.filter((node) => node.category === "terminal");
  if (terminals.length === 0) issues.push(issue("error", "missing-terminal", "Workflow must contain at least one terminal node."));

  for (const node of workflow.nodes) {
    for (const path of requiredConfigPaths(node)) {
      if (!nodeSatisfiesPath(node, path)) {
        issues.push(issue("error", "missing-required-config", `Node '${node.id}' is missing required config '${path}'.`, { nodeId: node.id }));
      }
    }

    const policy = node.humanInput ?? node.runtime?.humanInput;
    if (node.category === "human-input" || policy !== undefined) {
      if (policy?.resumable !== true || policy.resumeTokenPath === undefined) {
        issues.push(issue("error", "hitl-not-resumable", `Human input node '${node.id}' must be resumable and include resumeTokenPath.`, { nodeId: node.id }));
      }
    }

    if (node.nodeType !== undefined && (!Number.isInteger(node.nodeType.version) || node.nodeType.version < 1)) {
      issues.push(issue("error", "custom-node-version-unpinned", `Custom node '${node.id}' must pin a concrete reusable node type version.`, { nodeId: node.id }));
    }
    if (node.runtime?.kind === "external" && node.config?.codeBacked === true) {
      issues.push(issue("warning", "code-node-worker-only", `Code-backed node '${node.id}' is metadata-only in the web app and must execute in a worker.`, { nodeId: node.id }));
    }

    if (node.runtime?.kind === "adk") {
      if ((node.category === "router" || node.category === "loop") && node.runtime.supportsGraph !== true) {
        issues.push(issue("warning", "adk-graph-unsupported", `ADK node '${node.id}' may not support graph control flow.`, { nodeId: node.id }));
      }
      if (node.runtime.model?.stream === true && node.runtime.supportsLiveStreaming !== true) {
        issues.push(issue("warning", "adk-live-streaming-unsupported", `ADK node '${node.id}' requests streaming without live streaming support metadata.`, { nodeId: node.id }));
      }
      if (node.runtime.taskMode === true && (node.category === "router" || node.category === "loop" || node.category === "human-input")) {
        issues.push(issue("warning", "adk-task-mode-limited", `ADK task-mode node '${node.id}' has orchestration limitations.`, { nodeId: node.id }));
      }
    }
  }

  for (const edge of workflow.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined) {
      issues.push(issue("error", "invalid-endpoint", `Edge '${edge.id}' source '${edge.source}' does not exist.`, { edgeId: edge.id }));
      continue;
    }
    if (target === undefined) {
      issues.push(issue("error", "invalid-endpoint", `Edge '${edge.id}' target '${edge.target}' does not exist.`, { edgeId: edge.id }));
      continue;
    }

    const sourceHandles = handleSet(source.outputs);
    if (edge.sourceHandle !== undefined && sourceHandles.size > 0 && !sourceHandles.has(edge.sourceHandle)) {
      issues.push(issue("error", "invalid-source-handle", `Edge '${edge.id}' references unknown source handle '${edge.sourceHandle}'.`, { edgeId: edge.id, nodeId: source.id, handleId: edge.sourceHandle }));
    }
    const targetHandles = handleSet(target.inputs);
    if (edge.targetHandle !== undefined && targetHandles.size > 0 && !targetHandles.has(edge.targetHandle)) {
      issues.push(issue("error", "invalid-target-handle", `Edge '${edge.id}' references unknown target handle '${edge.targetHandle}'.`, { edgeId: edge.id, nodeId: target.id, handleId: edge.targetHandle }));
    }

    const sourceSchema = firstHandleSchema(source.outputs, edge.sourceHandle) ?? source.outputSchema;
    const targetSchema = firstHandleSchema(target.inputs, edge.targetHandle) ?? target.inputSchema;
    const transferSchema = edge.schema ?? sourceSchema;
    if (!isSchemaCompatible(transferSchema, targetSchema)) {
      issues.push(issue("error", "schema-incompatible", `Edge '${edge.id}' connects incompatible schemas.`, { edgeId: edge.id }));
    }
  }

  const graph = adjacency(workflow.nodes, workflow.edges);
  if (starts.length === 1) {
    const reachable = reachableFrom(starts[0].id, graph);
    for (const node of workflow.nodes) {
      if (!reachable.has(node.id)) issues.push(issue("error", "unreachable-node", `Node '${node.id}' is not reachable from the start node.`, { nodeId: node.id }));
    }
    if (!terminals.some((node) => reachable.has(node.id))) {
      issues.push(issue("error", "terminal-unreachable", "No terminal node is reachable from the start node."));
    }
  }

  for (const cycle of findCycles(workflow.nodes, graph)) {
    if (!cycleAllowed(cycle, byId)) {
      issues.push(issue("error", "cycle-detected", `Cycle detected without explicit loop exception: ${cycle.join(" -> ")}.`, { nodeId: cycle[0] }));
    }
  }

  for (const node of workflow.nodes.filter((candidate) => candidate.category === "router")) {
    const outgoing = workflow.edges.filter((edge) => edge.source === node.id);
    for (const branch of node.router?.branches ?? []) {
      if (!outgoing.some((edge) => edge.sourceHandle === branch.handle)) {
        issues.push(issue("error", "router-branch-missing-edge", `Router '${node.id}' branch '${branch.handle}' has no outgoing edge.`, { nodeId: node.id, handleId: branch.handle }));
      }
    }
    if (node.router?.requireDefault === true && !node.router.branches.some((branch) => branch.isDefault)) {
      issues.push(issue("error", "router-default-missing", `Router '${node.id}' requires a default branch.`, { nodeId: node.id }));
    }
  }

  const errors = issues.filter((entry) => entry.severity === "error");
  const warnings = issues.filter((entry) => entry.severity === "warning");
  return { valid: errors.length === 0, errors, warnings };
}

export function assertValidWorkflowDefinition(workflow: WorkflowDefinition): WorkflowDefinition {
  const result = validateWorkflowDefinition(workflow);
  if (!result.valid) {
    throw new Error(result.errors.map((entry) => `${entry.code}: ${entry.message}`).join("\n"));
  }
  return workflow;
}
