import { AgentBuilder } from "./AgentBuilder";

export default async function AgentBuilderPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  return <AgentBuilder agentId={agentId} />;
}
