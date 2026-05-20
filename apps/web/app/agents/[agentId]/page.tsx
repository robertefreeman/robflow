"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useState } from "react";

type VersionSummary = {
  version: { id: string; version: number; status: "draft" | "active" | "archived"; createdAt: string };
  metadata: { nodeCount: number; edgeCount: number; nodeTypes: string[]; categories: string[] };
};

type AgentDetail = {
  agent: { id: string; name: string; description: string | null; slug: string; currentVersionId: string | null };
  currentVersion: VersionSummary["version"] | null;
  draftVersion: VersionSummary["version"] | null;
  versions: VersionSummary[];
};

type TestCaseEntry = {
  testCase: { id: string; name: string; input: Record<string, unknown>; expected: Record<string, unknown>; updatedAt: string };
  runs: Array<{ id: string; status: "queued" | "running" | "passed" | "failed" | "errored" | "canceled"; result: Record<string, unknown>; createdAt: string; runId: string | null }>;
};

function statusLabel(status: VersionSummary["version"]["status"]) {
  return status === "active" ? "published" : status;
}

export default function AgentDetailPage({ params }: { params: Promise<{ agentId: string }> }) {
  const [agentId, setAgentId] = useState<string>("");
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [testCases, setTestCases] = useState<TestCaseEntry[]>([]);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [caseName, setCaseName] = useState("Smoke test");
  const [caseInput, setCaseInput] = useState('{\n  "prompt": "ping"\n}');
  const [caseExpected, setCaseExpected] = useState('{\n  "status": "succeeded",\n  "containsText": "ping",\n  "nodePath": ["start", "end"]\n}');
  const [status, setStatus] = useState("Loading agent…");

  useEffect(() => { void params.then((value) => setAgentId(value.agentId)); }, [params]);

  async function load(id = agentId) {
    if (!id) return;
    const response = await fetch(`/api/agents/${id}/detail`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to load agent");
    setDetail(data);
    setLeft(data.versions[1]?.version.id ?? data.versions[0]?.version.id ?? "");
    setRight(data.versions[0]?.version.id ?? "");
    setStatus("");
    await loadTestCases(id);
  }

  async function loadTestCases(id = agentId) {
    if (!id) return;
    const response = await fetch(`/api/agents/${id}/test-cases`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to load test cases");
    setTestCases(data.testCases ?? []);
  }

  useEffect(() => { load(agentId).catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Unable to load agent")); }, [agentId]);

  const sortedVersions = useMemo(() => detail?.versions ?? [], [detail]);

  async function clone() {
    setStatus("Cloning agent…");
    const response = await fetch(`/api/agents/${agentId}/clone`, { method: "POST" });
    const data = await response.json();
    if (!response.ok) return setStatus(data.error ?? "Unable to clone agent");
    window.location.href = `/agents/${data.agent.id}`;
  }

  async function rollback(versionId: string) {
    setStatus("Creating rollback draft…");
    const response = await fetch(`/api/agent-versions/${versionId}/rollback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId }) });
    const data = await response.json();
    if (!response.ok) return setStatus(data.error ?? "Unable to rollback version");
    await load();
    setStatus(`Draft v${data.version.version} created from rollback.`);
  }

  function editTestCase(entry: TestCaseEntry) {
    setCaseId(entry.testCase.id);
    setCaseName(entry.testCase.name);
    setCaseInput(JSON.stringify(entry.testCase.input, null, 2));
    setCaseExpected(JSON.stringify(entry.testCase.expected, null, 2));
  }

  function resetTestCaseForm() {
    setCaseId(null);
    setCaseName("Smoke test");
    setCaseInput('{\n  "prompt": "ping"\n}');
    setCaseExpected('{\n  "status": "succeeded",\n  "containsText": "ping",\n  "nodePath": ["start", "end"]\n}');
  }

  async function saveTestCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus(caseId ? "Updating test case…" : "Creating test case…");
    try {
      const payload = { name: caseName, input: JSON.parse(caseInput), expected: JSON.parse(caseExpected) };
      const url = caseId ? `/api/agents/${agentId}/test-cases/${caseId}` : `/api/agents/${agentId}/test-cases`;
      const response = await fetch(url, { method: caseId ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to save test case");
      await loadTestCases();
      resetTestCaseForm();
      setStatus("Test case saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Invalid test case JSON");
    }
  }

  async function deleteTestCase(id: string) {
    setStatus("Deleting test case…");
    const response = await fetch(`/api/agents/${agentId}/test-cases/${id}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) return setStatus(data.error ?? "Unable to delete test case");
    await loadTestCases();
    setStatus("Test case deleted.");
  }

  async function runTestCase(id: string) {
    const versionId = right || detail?.currentVersion?.id || detail?.versions[0]?.version.id;
    if (!versionId) return setStatus("Publish or save a version before running tests.");
    setStatus("Running deterministic test case…");
    const response = await fetch(`/api/agents/${agentId}/test-cases/${id}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentVersionId: versionId }) });
    const data = await response.json();
    if (!response.ok) return setStatus(data.error ?? "Unable to run test case");
    await loadTestCases();
    setStatus(`Test ${data.testRun.status}.`);
  }

  async function runAllTests() {
    const versionId = right || detail?.currentVersion?.id || detail?.versions[0]?.version.id;
    if (!versionId) return setStatus("Publish or save a version before running tests.");
    setStatus("Running all deterministic test cases…");
    const response = await fetch(`/api/agent-versions/${versionId}/test-cases/run-all`, { method: "POST" });
    const data = await response.json();
    if (!response.ok) return setStatus(data.error ?? "Unable to run test cases");
    await loadTestCases();
    setStatus(`Ran ${data.results?.length ?? 0} test cases.`);
  }

  return (
    <main className="page agents-page">
      <section className="panel agents-panel">
        <div className="page-heading">
          <div>
            <p className="eyebrow">agent lifecycle</p>
            <h1>{detail?.agent.name ?? "Agent"}</h1>
          </div>
          <Link className="secondary-link" href="/agents">Agents</Link>
        </div>
        {detail ? <p>{detail.agent.description || detail.agent.slug}</p> : null}
        <div className="button-row lifecycle-actions">
          <Link className="button-link" href={`/agents/${agentId}/builder`}>Open builder</Link>
          <Link className="button-link" href={`/agents/${agentId}/runs`}>Open run console</Link>
          <button type="button" onClick={clone}>Clone agent</button>
          <a className="button-link" href={`/api/agents/${agentId}/export`} download>Export robflow JSON</a>
          <a className="button-link" href={`/api/agents/${agentId}/test-cases/adk`} download>Export ADK evals</a>
        </div>
        {sortedVersions.length > 1 ? (
          <form className="settings-form compare-form" onSubmit={(event) => { event.preventDefault(); window.location.href = `/agents/${agentId}/compare?left=${left}&right=${right}`; }}>
            <div className="form-grid">
              <label>Base version<select value={left} onChange={(event) => setLeft(event.target.value)}>{sortedVersions.map((entry) => <option key={entry.version.id} value={entry.version.id}>v{entry.version.version} {statusLabel(entry.version.status)}</option>)}</select></label>
              <label>Compare version<select value={right} onChange={(event) => setRight(event.target.value)}>{sortedVersions.map((entry) => <option key={entry.version.id} value={entry.version.id}>v{entry.version.version} {statusLabel(entry.version.status)}</option>)}</select></label>
            </div>
            <div className="button-row"><button type="submit">Compare versions</button></div>
          </form>
        ) : null}
        {status ? <p className="status-output">{status}</p> : null}
        <div className="version-list">
          {sortedVersions.map((entry) => (
            <article className="version-card" key={entry.version.id}>
              <div>
                <strong>v{entry.version.version} · {statusLabel(entry.version.status)}</strong>
                {detail?.agent.currentVersionId === entry.version.id ? <span className="badge">current</span> : null}
                <p className="note">{entry.metadata.nodeCount} nodes · {entry.metadata.edgeCount} edges · {new Date(entry.version.createdAt).toLocaleString()}</p>
                <small>{entry.metadata.categories.join(", ") || "no categories"}</small>
              </div>
              <div className="version-actions">
                <a href={`/api/agent-versions/${entry.version.id}/export?format=ir`} download>IR JSON</a>
                <a href={`/api/agent-versions/${entry.version.id}/export?format=adk`} download>ADK bundle JSON</a>
                <button type="button" onClick={() => rollback(entry.version.id)}>Rollback to draft</button>
              </div>
            </article>
          ))}
        </div>
        <section className="eval-panel">
          <div className="page-heading">
            <div>
              <p className="eyebrow">agent evaluations</p>
              <h2>Deterministic test cases</h2>
            </div>
            <button type="button" onClick={runAllTests}>Run all</button>
          </div>
          <p className="note">Assertions support exact output, contains text, JSON schema, expected node path, expected tool calls, and expected status. The runner uses deterministic workflow simulation and never calls models by default.</p>
          <form className="settings-form eval-form" onSubmit={saveTestCase}>
            <label>Name<input value={caseName} onChange={(event) => setCaseName(event.target.value)} required /></label>
            <div className="form-grid">
              <label>Input JSON<textarea value={caseInput} onChange={(event) => setCaseInput(event.target.value)} rows={8} /></label>
              <label>Expected assertions JSON<textarea value={caseExpected} onChange={(event) => setCaseExpected(event.target.value)} rows={8} /></label>
            </div>
            <div className="button-row"><button type="submit">{caseId ? "Update test case" : "Create test case"}</button>{caseId ? <button type="button" onClick={resetTestCaseForm}>Cancel edit</button> : null}</div>
          </form>
          <div className="test-case-list">
            {testCases.map((entry) => {
              const latest = entry.runs[0];
              return (
                <article className="test-case-card" key={entry.testCase.id}>
                  <div>
                    <strong>{entry.testCase.name}</strong>
                    <p className="note">Latest: {latest ? `${latest.status} · ${new Date(latest.createdAt).toLocaleString()}` : "not run yet"}</p>
                    {latest ? <pre>{JSON.stringify(latest.result, null, 2)}</pre> : null}
                  </div>
                  <div className="version-actions">
                    <button type="button" onClick={() => runTestCase(entry.testCase.id)}>Run</button>
                    <button type="button" onClick={() => editTestCase(entry)}>Edit</button>
                    <button type="button" onClick={() => deleteTestCase(entry.testCase.id)}>Delete</button>
                  </div>
                </article>
              );
            })}
            {testCases.length === 0 ? <p className="note">No test cases yet. Add a smoke test to start collecting result history.</p> : null}
          </div>
        </section>
      </section>
    </main>
  );
}
