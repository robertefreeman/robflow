import { createPostgresDatabase, createPersistenceRepositories, type SecretRecord } from "@robflow/persistence";
import {
  INFERENCE_API_KEY_SECRET_NAME,
  INFERENCE_CONFIG_KEY,
  INFERENCE_SECRET_SCOPE,
  coerceStoredInferenceConfig,
  decryptInferenceSecret,
  encryptInferenceSecret,
  fetchOpenAIModels,
  normalizeInferenceConfig,
  redactInferenceConfig,
  type InferenceConfigInput,
  type RedactedInferenceConfig,
  type ResolvedInferenceConfig,
  type StoredInferenceConfig
} from "./inference-config";

export type PersistenceRepositories = ReturnType<typeof createPersistenceRepositories>;

let cachedRepos: PersistenceRepositories | undefined;

export function getServerRepositories(): PersistenceRepositories {
  cachedRepos ??= createPersistenceRepositories(createPostgresDatabase().db);
  return cachedRepos;
}

export async function readStoredInferenceConfig(repos: PersistenceRepositories = getServerRepositories()): Promise<StoredInferenceConfig> {
  const config = await repos.appConfig.get(INFERENCE_CONFIG_KEY);
  return coerceStoredInferenceConfig(config?.value);
}

async function upsertInferenceSecret(repos: PersistenceRepositories, apiKey: string, env: Record<string, string | undefined>): Promise<SecretRecord> {
  const encrypted = encryptInferenceSecret(apiKey, env);
  const existing = await repos.secrets.getByScopeName(INFERENCE_SECRET_SCOPE, INFERENCE_API_KEY_SECRET_NAME);
  if (existing) {
    const updated = await repos.secrets.updateCiphertext(existing.id, {
      ...encrypted,
      metadata: { purpose: "openai-compatible-inference" }
    });
    if (!updated) {
      throw new Error("Failed to update inference API key secret");
    }
    return updated;
  }
  return repos.secrets.create({
    scope: INFERENCE_SECRET_SCOPE,
    name: INFERENCE_API_KEY_SECRET_NAME,
    ...encrypted,
    metadata: { purpose: "openai-compatible-inference" }
  });
}

export async function getRedactedInferenceConfig(repos: PersistenceRepositories = getServerRepositories()): Promise<RedactedInferenceConfig> {
  return redactInferenceConfig(await readStoredInferenceConfig(repos));
}

export async function saveInferenceConfig(
  input: InferenceConfigInput | Record<string, unknown>,
  repos: PersistenceRepositories = getServerRepositories(),
  env: Record<string, string | undefined> = process.env
): Promise<RedactedInferenceConfig> {
  const existing = await readStoredInferenceConfig(repos);
  let next = normalizeInferenceConfig(input, existing);
  if (typeof input.apiKey === "string" && input.apiKey.trim()) {
    const secret = await upsertInferenceSecret(repos, input.apiKey.trim(), env);
    next = { ...next, apiKeySecretId: secret.id };
  }

  await repos.appConfig.upsert({
    key: INFERENCE_CONFIG_KEY,
    value: { ...next },
    description: "Global OpenAI-compatible inference endpoint configuration"
  });
  return redactInferenceConfig(next);
}

export async function resolveInferenceConfig(
  repos: PersistenceRepositories = getServerRepositories(),
  env: Record<string, string | undefined> = process.env
): Promise<ResolvedInferenceConfig> {
  const config = await readStoredInferenceConfig(repos);
  if (!config.apiKeySecretId) {
    return config;
  }
  const secret = await repos.secrets.get(config.apiKeySecretId);
  if (!secret) {
    throw new Error("Configured inference API key secret is missing");
  }
  return { ...config, apiKey: decryptInferenceSecret(secret.ciphertext, env) };
}

export async function testInferenceConnection(repos: PersistenceRepositories = getServerRepositories(), env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch) {
  return fetchOpenAIModels(await resolveInferenceConfig(repos, env), fetchImpl);
}

export async function discoverAndSaveInferenceModels(
  repos: PersistenceRepositories = getServerRepositories(),
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch
) {
  const result = await testInferenceConnection(repos, env, fetchImpl);
  if (!result.ok) {
    return result;
  }

  const existing = await readStoredInferenceConfig(repos);
  const models = result.models ?? [];
  const defaultModel = existing.defaultModel || models[0] || "";
  await repos.appConfig.upsert({
    key: INFERENCE_CONFIG_KEY,
    value: { ...existing, models, defaultModel },
    description: "Global OpenAI-compatible inference endpoint configuration"
  });
  return { ...result, models, defaultModel };
}
