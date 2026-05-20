"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

type AgentSummary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  summary?: { versionCount: number; publishedCount: number; draftVersion: { version: number } | null; currentVersion: { version: number } | null };
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [name, setName] = useState("New workflow agent");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const [importJson, setImportJson] = useState("");
  const [status, setStatus] = useState("Loading agents…");

  async function loadAgents(search = query) {
    const params = search.trim() ? `?q=${encodeURIComponent(search.trim())}` : "";
    const response = await fetch(`/api/agents${params}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to load agents");
    setAgents(data.agents ?? []);
    setStatus("");
  }

  useEffect(() => {
    loadAgents().catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Unable to load agents"));
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("Creating agent…");
    const response = await fetch("/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description }) });
    const data = await response.json();
    if (!response.ok) {
      setStatus(data.error ?? "Unable to create agent");
      return;
    }
    window.location.href = `/agents/${data.agent.id}/builder`;
  }

  async function importProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("Importing project…");
    const response = await fetch("/api/agents/import", { method: "POST", headers: { "content-type": "application/json" }, body: importJson });
    const data = await response.json();
    if (!response.ok) {
      setStatus(data.error ?? "Unable to import project");
      return;
    }
    window.location.href = `/agents/${data.agent.id}`;
  }

  return (
    <main className="page agents-page">
      <section className="panel agents-panel">
        <div className="page-heading">
          <div>
            <p className="eyebrow">robflow agents</p>
            <h1>Visual builder</h1>
          </div>
          <Link className="secondary-link" href="/">Home</Link>
        </div>
        <form className="settings-form create-agent-form" onSubmit={create}>
          <label>
            Agent name
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            Description
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} />
          </label>
          <div className="button-row"><button type="submit">Create agent</button></div>
        </form>
        <form className="settings-form search-form" onSubmit={(event) => { event.preventDefault(); void loadAgents(query); }}>
          <label>
            Search agents
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, slug, or description" />
          </label>
          <div className="button-row"><button type="submit">Search</button><button type="button" onClick={() => { setQuery(""); void loadAgents(""); }}>Clear</button></div>
        </form>
        <form className="settings-form import-form" onSubmit={importProject}>
          <label>
            Import robflow project JSON
            <textarea value={importJson} onChange={(event) => setImportJson(event.target.value)} rows={4} placeholder='{"format":"robflow-project",...}' />
          </label>
          <div className="button-row"><button type="submit" disabled={!importJson.trim()}>Import project</button></div>
        </form>
        {status ? <p className="status-output">{status}</p> : null}
        <div className="agent-list">
          {agents.map((agent) => (
            <Link className="agent-card" href={`/agents/${agent.id}`} key={agent.id}>
              <strong>{agent.name}</strong>
              <span>{agent.description || agent.slug}</span>
              <small>{agent.summary?.publishedCount ?? 0} published · {agent.summary?.draftVersion ? `draft v${agent.summary.draftVersion.version}` : "no draft"} · {agent.summary?.currentVersion ? `current v${agent.summary.currentVersion.version}` : "unpublished"}</small>
            </Link>
          ))}
          {agents.length === 0 && !status ? <p className="note">No agents yet. Create one to open the canvas.</p> : null}
        </div>
      </section>
    </main>
  );
}
