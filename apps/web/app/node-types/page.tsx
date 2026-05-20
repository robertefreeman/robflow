"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

type LibraryEntry = {
  nodeType: { id: string; slug: string; displayName: string; description: string | null; category: string; builtIn: boolean };
  latestVersion: { version: number; definition: Record<string, unknown>; runtime: Record<string, unknown> } | null;
};

const starterDefinition = {
  kind: "prompt-template",
  label: "Reusable prompt",
  category: "action",
  inputs: [{ id: "in" }],
  outputs: [{ id: "out" }],
  promptTemplate: "Summarize: {{input}}"
};

export default function NodeTypesPage() {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [displayName, setDisplayName] = useState("Reusable prompt");
  const [slug, setSlug] = useState("reusable-prompt");
  const [kind, setKind] = useState("prompt-template");
  const [definitionText, setDefinitionText] = useState(JSON.stringify(starterDefinition, null, 2));
  const [status, setStatus] = useState("Loading node types…");

  async function load() {
    const response = await fetch("/api/node-types", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to load node types");
    setEntries(data.nodeTypes ?? []);
    setStatus("");
  }

  useEffect(() => {
    load().catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Unable to load node types"));
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("Creating node type…");
    let definition: Record<string, unknown>;
    try {
      definition = JSON.parse(definitionText) as Record<string, unknown>;
    } catch {
      setStatus("Definition must be valid JSON.");
      return;
    }
    definition.kind = kind;
    definition.label = displayName;
    const response = await fetch("/api/node-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, displayName, category: definition.category, definition })
    });
    const data = await response.json();
    if (!response.ok) {
      setStatus(data.error ?? "Unable to create node type");
      return;
    }
    await load();
  }

  return (
    <main className="page node-types-page">
      <section className="panel node-types-panel">
        <div className="page-heading">
          <div>
            <p className="eyebrow">robflow library</p>
            <h1>Reusable node types</h1>
          </div>
          <Link className="secondary-link" href="/agents">Visual builder</Link>
        </div>
        <form className="settings-form create-node-type-form" onSubmit={create}>
          <div className="form-grid">
            <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label>
            <label>Slug<input value={slug} onChange={(event) => setSlug(event.target.value)} required /></label>
            <label>Definition kind
              <select value={kind} onChange={(event) => setKind(event.target.value)}>
                <option value="prompt-template">Prompt template</option>
                <option value="router-rules">Router rules</option>
                <option value="schema-transform">Schema transform</option>
                <option value="model-preset">Model preset</option>
                <option value="agent-preset">Agent preset</option>
                <option value="python-function">Python function (worker-only)</option>
                <option value="http-api">HTTP/API (worker-only)</option>
                <option value="openapi-operation">OpenAPI operation (worker-only)</option>
                <option value="adk-tool-wrapper">ADK tool wrapper (worker-only)</option>
              </select>
            </label>
          </div>
          <label>Definition JSON<textarea value={definitionText} onChange={(event) => setDefinitionText(event.target.value)} rows={12} /></label>
          <div className="button-row"><button type="submit">Create reusable node type</button></div>
        </form>
        {status ? <p className="status-output">{status}</p> : null}
        <div className="node-type-list">
          {entries.map((entry) => (
            <article className="node-type-card" key={entry.nodeType.id}>
              <div>
                <strong>{entry.nodeType.displayName}</strong>
                <span>{entry.nodeType.slug} · v{entry.latestVersion?.version ?? "—"} · {entry.nodeType.category}</span>
              </div>
              <p>{entry.nodeType.description || String(entry.latestVersion?.definition.kind ?? "custom node")}</p>
              {entry.latestVersion?.runtime && Object.keys(entry.latestVersion.runtime).length > 0 ? <code>{JSON.stringify(entry.latestVersion.runtime)}</code> : null}
            </article>
          ))}
          {entries.length === 0 && !status ? <p className="note">No reusable node types yet.</p> : null}
        </div>
      </section>
    </main>
  );
}
