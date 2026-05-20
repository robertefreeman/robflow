import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPersistenceRepositories, schema } from "@robflow/persistence";
import { decryptInferenceSecret, encryptInferenceSecret, extractModelIds, fetchOpenAIModels } from "../lib/inference-config";
import { getRedactedInferenceConfig, resolveInferenceConfig, saveInferenceConfig, testInferenceConnection } from "../lib/inference-store";

const migrationsFolder = fileURLToPath(new URL("../../../packages/persistence/drizzle", import.meta.url));
const encryptionEnv = { INFERENCE_CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };

describe("inference config", () => {
  let client: PGlite;
  let repos: ReturnType<typeof createPersistenceRepositories>;

  beforeEach(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
    repos = createPersistenceRepositories(db);
  });

  afterEach(async () => {
    await client.close();
  });

  it("encrypts API keys and returns only redacted settings", async () => {
    const saved = await saveInferenceConfig(
      {
        baseUrl: "https://llm.example/v1/",
        apiKey: "sk-test",
        defaultModel: "demo-model",
        headers: { "X-Test": "yes" },
        timeoutMs: 12000,
        maxRetries: 3
      },
      repos,
      encryptionEnv
    );

    expect(saved).toMatchObject({ baseUrl: "https://llm.example/v1", apiKeySet: true, defaultModel: "demo-model" });
    expect(JSON.stringify(saved)).not.toContain("sk-test");

    const redacted = await getRedactedInferenceConfig(repos);
    const resolved = await resolveInferenceConfig(repos, encryptionEnv);
    expect(redacted.apiKeySet).toBe(true);
    expect(resolved.apiKey).toBe("sk-test");
  });

  it("fails loudly when encryption key is missing for secret writes", async () => {
    await expect(
      saveInferenceConfig({ baseUrl: "https://llm.example/v1", apiKey: "sk-test", defaultModel: "demo-model" }, repos, {})
    ).rejects.toThrow("INFERENCE_CONFIG_ENCRYPTION_KEY");
  });

  it("round trips local AES-GCM secrets", () => {
    const encrypted = encryptInferenceSecret("super-secret", encryptionEnv);
    expect(encrypted.ciphertext).not.toContain("super-secret");
    expect(decryptInferenceSecret(encrypted.ciphertext, encryptionEnv)).toBe("super-secret");
  });

  it("tests OpenAI-compatible /models without real network calls", async () => {
    await saveInferenceConfig({ baseUrl: "https://llm.example/v1", apiKey: "sk-test", defaultModel: "demo-model" }, repos, encryptionEnv);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "demo-model" }, { id: "other-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    ) as unknown as typeof fetch;

    const result = await testInferenceConnection(repos, encryptionEnv, fetchImpl);

    expect(result).toMatchObject({ ok: true, models: ["demo-model", "other-model"] });
    expect(fetchImpl).toHaveBeenCalledWith("https://llm.example/v1/models", expect.objectContaining({ method: "GET" }));
  });

  it("reports endpoint errors without swallowing details", async () => {
    const result = await fetchOpenAIModels(
      { baseUrl: "https://llm.example/v1", defaultModel: "demo", headers: {}, timeoutMs: 1000, maxRetries: 0 },
      async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401, statusText: "Unauthorized", headers: { "content-type": "application/json" } })
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain("bad key");
  });



  it("retries transient model discovery failures", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503, statusText: "Unavailable" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "after-retry" }] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const result = await fetchOpenAIModels(
      { baseUrl: "https://llm.example/v1", defaultModel: "demo", headers: {}, timeoutMs: 1000, maxRetries: 1 },
      fetchImpl
    );

    expect(result).toMatchObject({ ok: true, models: ["after-retry"] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("extracts model ids when discovery is supported", () => {
    expect(extractModelIds({ data: [{ id: "one" }, { id: "two" }, { object: "ignored" }] })).toEqual(["one", "two"]);
  });
});
