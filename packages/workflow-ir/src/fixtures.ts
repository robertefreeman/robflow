import { WORKFLOW_IR_SCHEMA_VERSION, type WorkflowDefinition } from "./types.js";

const promptSchema = {
  type: "object",
  properties: {
    prompt: { type: "string" }
  },
  required: ["prompt"]
} as const;

const answerSchema = {
  type: "object",
  properties: {
    answer: { type: "string" },
    needsHumanReview: { type: "boolean" }
  },
  required: ["answer"]
} as const;

export const validWorkflowFixture: WorkflowDefinition = {
  schemaVersion: WORKFLOW_IR_SCHEMA_VERSION,
  id: "golden-valid-support-workflow",
  name: "Golden Valid Support Workflow",
  version: "1",
  nodes: [
    {
      id: "start",
      type: "trigger.manual",
      category: "start",
      name: "Start",
      outputSchema: promptSchema,
      outputs: [{ id: "out", schema: promptSchema }]
    },
    {
      id: "agent",
      type: "action.adk-agent",
      category: "action",
      name: "ADK Agent",
      inputSchema: promptSchema,
      outputSchema: answerSchema,
      inputs: [{ id: "in", schema: promptSchema }],
      outputs: [{ id: "out", schema: answerSchema }],
      runtime: {
        kind: "adk",
        entrypoint: "support_agent.run",
        model: {
          provider: "google",
          model: "gemini-2.0-flash",
          responseSchema: answerSchema,
          stream: true
        },
        retry: {
          maxAttempts: 3,
          backoff: "exponential",
          initialDelayMs: 250,
          maxDelayMs: 2_000
        },
        supportsLiveStreaming: true
      }
    },
    {
      id: "route-review",
      type: "router.condition",
      category: "router",
      name: "Route Review",
      inputSchema: answerSchema,
      inputs: [{ id: "in", schema: answerSchema }],
      outputs: [{ id: "needs-review" }, { id: "default" }],
      router: {
        requireDefault: true,
        branches: [
          { handle: "needs-review", condition: "needsHumanReview === true" },
          { handle: "default", isDefault: true }
        ]
      }
    },
    {
      id: "human-review",
      type: "human.approval",
      category: "human-input",
      name: "Human Review",
      inputSchema: answerSchema,
      outputSchema: answerSchema,
      inputs: [{ id: "in", schema: answerSchema }],
      outputs: [{ id: "out", schema: answerSchema }],
      humanInput: {
        prompt: "Review the generated answer",
        resumable: true,
        resumeTokenPath: "$.resume.token",
        assignedRole: "support-lead"
      }
    },
    {
      id: "end",
      type: "terminal.success",
      category: "terminal",
      name: "Done",
      inputSchema: answerSchema,
      inputs: [{ id: "in", schema: answerSchema }]
    }
  ],
  edges: [
    { id: "start-agent", source: "start", sourceHandle: "out", target: "agent", targetHandle: "in" },
    { id: "agent-router", source: "agent", sourceHandle: "out", target: "route-review", targetHandle: "in" },
    { id: "router-human", source: "route-review", sourceHandle: "needs-review", target: "human-review", targetHandle: "in" },
    { id: "human-end", source: "human-review", sourceHandle: "out", target: "end", targetHandle: "in" },
    { id: "router-end", source: "route-review", sourceHandle: "default", target: "end", targetHandle: "in" }
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
  metadata: { fixture: true }
};

export const invalidWorkflowFixtures: readonly WorkflowDefinition[] = [
  {
    schemaVersion: WORKFLOW_IR_SCHEMA_VERSION,
    id: "golden-invalid-structure",
    name: "Golden Invalid Structure",
    version: "1",
    nodes: [
      { id: "start-a", type: "trigger.manual", category: "start", name: "Start A", outputs: [{ id: "out" }] },
      { id: "start-b", type: "trigger.webhook", category: "start", name: "Start B", outputs: [{ id: "out" }] },
      {
        id: "agent",
        type: "action.adk-agent",
        category: "action",
        name: "Agent Missing Runtime",
        requiredConfig: ["apiKeySecret"],
        inputSchema: { type: "string" },
        outputSchema: { type: "string" },
        runtime: { kind: "adk" }
      },
      { id: "end", type: "terminal.success", category: "terminal", name: "Done", inputSchema: { type: "number" } }
    ],
    edges: [
      { id: "bad-source-handle", source: "start-a", sourceHandle: "missing", target: "agent" },
      { id: "bad-schema", source: "agent", target: "end" },
      { id: "dangling", source: "agent", target: "missing-node" }
    ]
  },
  {
    schemaVersion: WORKFLOW_IR_SCHEMA_VERSION,
    id: "golden-invalid-router-hitl-cycle",
    name: "Golden Invalid Router HITL Cycle",
    version: "1",
    nodes: [
      { id: "start", type: "trigger.manual", category: "start", name: "Start" },
      {
        id: "router",
        type: "router.condition",
        category: "router",
        name: "Router",
        outputs: [{ id: "yes" }, { id: "default" }],
        router: { requireDefault: true, branches: [{ handle: "yes", condition: "ok" }] }
      },
      {
        id: "human",
        type: "human.input",
        category: "human-input",
        name: "Human",
        humanInput: { prompt: "Continue?", resumable: false }
      },
      { id: "end", type: "terminal.success", category: "terminal", name: "Done" }
    ],
    edges: [
      { id: "start-router", source: "start", target: "router" },
      { id: "router-human", source: "router", sourceHandle: "yes", target: "human" },
      { id: "human-router", source: "human", target: "router" }
    ]
  }
];
