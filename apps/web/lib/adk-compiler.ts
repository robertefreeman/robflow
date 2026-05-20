import { createAdkExportBundle, type AdkExportBundle } from "@robflow/compiler-adk";
import { isWorkflowDefinition } from "@robflow/workflow-ir";
import { getServerRepositories, type PersistenceRepositories } from "./inference-store";

export async function compileAgentVersionAdkExport(agentVersionId: string, repos: PersistenceRepositories = getServerRepositories()): Promise<AdkExportBundle> {
  const latestIr = await repos.workflows.latestIr(agentVersionId);
  if (!latestIr) {
    throw new Error(`No workflow IR found for agent version '${agentVersionId}'.`);
  }
  if (!isWorkflowDefinition(latestIr.ir)) {
    throw new Error(`Workflow IR for agent version '${agentVersionId}' is not a supported robflow IR document.`);
  }
  return createAdkExportBundle(latestIr.ir, `agent-version-${agentVersionId}`);
}
