import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const INFERENCE_CONFIG_KEY = "inference.global";
export const INFERENCE_SECRET_SCOPE = "inference";
export const INFERENCE_API_KEY_SECRET_NAME = "global-api-key";
export const INFERENCE_ENCRYPTION_KEY_ENV = "INFERENCE_CONFIG_ENCRYPTION_KEY";

export interface InferenceConfigInput {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly defaultModel: string;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

export interface StoredInferenceConfig {
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly headers: Record<string, string>;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly apiKeySecretId?: string;
}

export interface RedactedInferenceConfig extends StoredInferenceConfig {
  readonly apiKeySet: boolean;
  readonly apiKeySecretId?: never;
}

export interface ResolvedInferenceConfig extends StoredInferenceConfig {
  readonly apiKey?: string;
}

export interface InferenceTestResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly statusText?: string;
  readonly durationMs: number;
  readonly models?: string[];
  readonly error?: string;
}

export const defaultInferenceConfig: StoredInferenceConfig = {
  baseUrl: "",
  defaultModel: "",
  headers: {},
  timeoutMs: 30000,
  maxRetries: 2
};

const encryptedPrefix = "aes-256-gcm:";
const forbiddenHeaderNames = new Set(["host", "content-length", "connection", "transfer-encoding"]);

function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("Endpoint base URL is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Endpoint base URL must be a valid URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Endpoint base URL must use http or https");
  }

  return parsed.toString().replace(/\/+$/, "");
}

export function normalizeHeaders(headers: unknown): Record<string, string> {
  if (headers === undefined || headers === null || headers === "") {
    return {};
  }

  const record = assertRecord(headers, "Headers");
  return Object.fromEntries(
    Object.entries(record).map(([name, value]) => {
      const headerName = name.trim();
      if (!headerName) {
        throw new Error("Header names cannot be empty");
      }
      if (forbiddenHeaderNames.has(headerName.toLowerCase())) {
        throw new Error(`Header ${headerName} is managed by the runtime and cannot be configured`);
      }
      if (typeof value !== "string") {
        throw new Error(`Header ${headerName} must have a string value`);
      }
      return [headerName, value];
    })
  );
}

function normalizeInteger(value: unknown, field: string, min: number, max: number, fallback: number): number {
  const normalized = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return normalized;
}

export function normalizeInferenceConfig(input: InferenceConfigInput | Record<string, unknown>, existing?: StoredInferenceConfig | null): StoredInferenceConfig {
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl : existing?.baseUrl ?? "";
  const defaultModel = typeof input.defaultModel === "string" ? input.defaultModel.trim() : existing?.defaultModel ?? "";
  if (!defaultModel) {
    throw new Error("Default model is required");
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    defaultModel,
    headers: normalizeHeaders(input.headers ?? existing?.headers),
    timeoutMs: normalizeInteger(input.timeoutMs, "Timeout", 1000, 300000, existing?.timeoutMs ?? defaultInferenceConfig.timeoutMs),
    maxRetries: normalizeInteger(input.maxRetries, "Max retries", 0, 10, existing?.maxRetries ?? defaultInferenceConfig.maxRetries),
    apiKeySecretId: existing?.apiKeySecretId
  };
}

export function coerceStoredInferenceConfig(value: unknown): StoredInferenceConfig {
  if (!value) {
    return defaultInferenceConfig;
  }
  const record = assertRecord(value, "Stored inference config");
  const apiKeySecretId = typeof record.apiKeySecretId === "string" && record.apiKeySecretId ? record.apiKeySecretId : undefined;

  if (!record.baseUrl && !record.defaultModel) {
    return { ...defaultInferenceConfig, apiKeySecretId };
  }

  return {
    ...normalizeInferenceConfig(record),
    apiKeySecretId
  };
}

export function redactInferenceConfig(config: StoredInferenceConfig): RedactedInferenceConfig {
  return {
    baseUrl: config.baseUrl,
    defaultModel: config.defaultModel,
    headers: config.headers,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    apiKeySet: Boolean(config.apiKeySecretId)
  };
}

function decodeEncryptionKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env[INFERENCE_ENCRYPTION_KEY_ENV];
  if (!raw) {
    throw new Error(`${INFERENCE_ENCRYPTION_KEY_ENV} is required to write or read inference API keys`);
  }

  const key = raw.startsWith("base64:") ? Buffer.from(raw.slice(7), "base64") : Buffer.from(raw, /^[0-9a-f]{64}$/i.test(raw) ? "hex" : "base64");
  if (key.length !== 32) {
    throw new Error(`${INFERENCE_ENCRYPTION_KEY_ENV} must decode to 32 bytes (base64 or 64 hex characters)`);
  }
  return key;
}

export function encryptInferenceSecret(plaintext: string, env: Record<string, string | undefined> = process.env): { ciphertext: string; encryptionKeyRef: string } {
  if (!plaintext) {
    throw new Error("Cannot encrypt an empty inference API key");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeEncryptionKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: `${encryptedPrefix}${Buffer.concat([iv, tag, encrypted]).toString("base64")}`,
    encryptionKeyRef: INFERENCE_ENCRYPTION_KEY_ENV
  };
}

export function decryptInferenceSecret(ciphertext: string, env: Record<string, string | undefined> = process.env): string {
  if (!ciphertext.startsWith(encryptedPrefix)) {
    throw new Error("Unsupported inference secret ciphertext format");
  }
  const payload = Buffer.from(ciphertext.slice(encryptedPrefix.length), "base64");
  if (payload.length <= 28) {
    throw new Error("Inference secret ciphertext is malformed");
  }
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", decodeEncryptionKey(env), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function buildOpenAIHeaders(config: ResolvedInferenceConfig): HeadersInit {
  const headers: Record<string, string> = { ...config.headers };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

export async function fetchOpenAIModels(config: ResolvedInferenceConfig, fetchImpl: typeof fetch = fetch): Promise<InferenceTestResult> {
  if (!config.baseUrl) {
    throw new Error("Inference endpoint base URL is not configured");
  }

  const started = Date.now();
  let lastError = "Unknown connection error";
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(`${config.baseUrl}/models`, {
        method: "GET",
        headers: buildOpenAIHeaders(config),
        signal: controller.signal
      });
      const contentType = response.headers.get("content-type") ?? "";
      const body = contentType.includes("application/json") ? await response.json() : await response.text();
      if (!response.ok) {
        lastError = typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500);
        if (response.status >= 500 && attempt < config.maxRetries) {
          continue;
        }
        return {
          ok: false,
          status: response.status,
          statusText: response.statusText,
          durationMs: Date.now() - started,
          error: lastError
        };
      }

      return {
        ok: true,
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - started,
        models: extractModelIds(body)
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown connection error";
      if (attempt >= config.maxRetries) {
        return {
          ok: false,
          durationMs: Date.now() - started,
          error: lastError
        };
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: false, durationMs: Date.now() - started, error: lastError };
}

export function extractModelIds(body: unknown): string[] {
  const record = assertRecord(body, "Model response");
  const data = record.data;
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((model) => {
    if (model && typeof model === "object" && typeof (model as { id?: unknown }).id === "string") {
      return [(model as { id: string }).id];
    }
    return [];
  });
}
