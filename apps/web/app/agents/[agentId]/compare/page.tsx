"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type DiffItem = { id: string; [key: string]: unknown };
type CompareResult = {
  left: { version: { version: number } };
  right: { version: { version: number } };
  graph: {
    nodeCountDelta: number;
    edgeCountDelta: number;
    nodes: { added: DiffItem[]; removed: DiffItem[]; changed: DiffItem[] };
    edges: { added: DiffItem[]; removed: DiffItem[]; changed: DiffItem[] };
  };
  irChanged: boolean;
};

function DiffList({ title, items }: { title: string; items: DiffItem[] }) {
  return <div><h3>{title}</h3>{items.length ? <pre>{JSON.stringify(items, null, 2)}</pre> : <p className="note">None</p>}</div>;
}

export default function ComparePage({ params, searchParams }: { params: Promise<{ agentId: string }>; searchParams: Promise<{ left?: string; right?: string }> }) {
  const [agentId, setAgentId] = useState("");
  const [result, setResult] = useState<CompareResult | null>(null);
  const [status, setStatus] = useState("Loading comparison…");

  useEffect(() => {
    async function load() {
      const [{ agentId: id }, query] = await Promise.all([params, searchParams]);
      setAgentId(id);
      const response = await fetch(`/api/agents/${id}/compare?left=${encodeURIComponent(query.left ?? "")}&right=${encodeURIComponent(query.right ?? "")}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to compare versions");
      setResult(data);
      setStatus("");
    }
    load().catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Unable to compare versions"));
  }, [params, searchParams]);

  return (
    <main className="page agents-page">
      <section className="panel agents-panel">
        <div className="page-heading"><div><p className="eyebrow">version compare</p><h1>Graph and IR diff</h1></div><Link className="secondary-link" href={`/agents/${agentId}`}>Agent detail</Link></div>
        {status ? <p className="status-output">{status}</p> : null}
        {result ? <>
          <p>v{result.left.version.version} → v{result.right.version.version}: {result.graph.nodeCountDelta} nodes, {result.graph.edgeCountDelta} edges. IR changed: {result.irChanged ? "yes" : "no"}.</p>
          <div className="diff-grid">
            <DiffList title="Added nodes" items={result.graph.nodes.added} />
            <DiffList title="Removed nodes" items={result.graph.nodes.removed} />
            <DiffList title="Changed nodes" items={result.graph.nodes.changed} />
            <DiffList title="Added edges" items={result.graph.edges.added} />
            <DiffList title="Removed edges" items={result.graph.edges.removed} />
            <DiffList title="Changed edges" items={result.graph.edges.changed} />
          </div>
        </> : null}
      </section>
    </main>
  );
}
