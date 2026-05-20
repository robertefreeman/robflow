"use client";

import { useEffect, useMemo, useState } from "react";
import type { InferenceTestResult, RedactedInferenceConfig } from "../../../lib/inference-config";

function isRedactedInferenceConfig(value: RedactedInferenceConfig | { error?: string }): value is RedactedInferenceConfig {
  return "baseUrl" in value && "defaultModel" in value && "headers" in value;
}

const emptyConfig: RedactedInferenceConfig = {
  baseUrl: "",
  defaultModel: "",
  headers: {},
  timeoutMs: 30000,
  maxRetries: 2,
  apiKeySet: false
};

export function InferenceSettingsForm() {
  const [config, setConfig] = useState<RedactedInferenceConfig>(emptyConfig);
  const [apiKey, setApiKey] = useState("");
  const [headersJson, setHeadersJson] = useState("{}");
  const [status, setStatus] = useState("Loading settings…");
  const [models, setModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/inference")
      .then(async (response) => {
        const body = (await response.json()) as RedactedInferenceConfig | { error?: string };
        if (!response.ok || !isRedactedInferenceConfig(body)) {
          throw new Error("error" in body ? body.error : "Failed to load settings");
        }
        return body;
      })
      .then((body) => {
        if (cancelled) {
          return;
        }
        setConfig(body);
        setHeadersJson(JSON.stringify(body.headers, null, 2));
        setStatus(body.baseUrl ? "Settings loaded." : "Configure and save an endpoint before testing.");
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : "Failed to load settings");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const apiKeyHelp = useMemo(() => (config.apiKeySet ? "A key is stored. Leave blank to keep it." : "No API key stored."), [config.apiKeySet]);

  async function save() {
    setSaving(true);
    setStatus("Saving settings…");
    try {
      const parsedHeaders = JSON.parse(headersJson || "{}");
      const response = await fetch("/api/settings/inference", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...config, headers: parsedHeaders, apiKey })
      });
      const body = (await response.json()) as RedactedInferenceConfig | { error?: string };
      if (!response.ok || !isRedactedInferenceConfig(body)) {
        throw new Error("error" in body ? body.error : "Failed to save settings");
      }
      setConfig(body);
      setApiKey("");
      setHeadersJson(JSON.stringify(body.headers, null, 2));
      setStatus("Settings saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setStatus("Testing connection…");
    const response = await fetch("/api/settings/inference/test", { method: "POST" });
    const result = (await response.json()) as InferenceTestResult;
    setModels(result.models ?? []);
    setStatus(result.ok ? `Connection OK (${result.durationMs} ms).` : `Connection failed: ${result.error ?? result.statusText ?? "unknown error"}`);
  }

  async function discoverModels() {
    setStatus("Discovering models…");
    const response = await fetch("/api/settings/inference/models");
    const body = (await response.json()) as { models?: string[]; error?: string } & InferenceTestResult;
    if (!response.ok) {
      setStatus(`Model discovery failed: ${body.error ?? body.statusText ?? "unknown error"}`);
      return;
    }
    setModels(body.models ?? []);
    setStatus(`Discovered ${(body.models ?? []).length} model(s).`);
  }

  return (
    <form className="settings-form" onSubmit={(event) => event.preventDefault()}>
      <label>
        Endpoint base URL
        <input name="baseUrl" value={config.baseUrl} onChange={(event) => setConfig({ ...config, baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" autoComplete="off" />
      </label>
      <label>
        API key
        <input name="apiKey" value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder="Leave blank to keep the stored key" autoComplete="new-password" />
        <span className="field-help">{apiKeyHelp}</span>
      </label>
      <label>
        Default model
        <input name="defaultModel" value={config.defaultModel} onChange={(event) => setConfig({ ...config, defaultModel: event.target.value })} placeholder="gpt-4o-mini" autoComplete="off" />
      </label>
      <label>
        Optional headers (JSON)
        <textarea name="headers" value={headersJson} onChange={(event) => setHeadersJson(event.target.value)} rows={5} />
      </label>
      <div className="form-grid">
        <label>
          Timeout (ms)
          <input name="timeoutMs" type="number" min={1000} max={300000} value={config.timeoutMs} onChange={(event) => setConfig({ ...config, timeoutMs: Number(event.target.value) })} />
        </label>
        <label>
          Max retries
          <input name="maxRetries" type="number" min={0} max={10} value={config.maxRetries} onChange={(event) => setConfig({ ...config, maxRetries: Number(event.target.value) })} />
        </label>
      </div>
      <div className="button-row">
        <button type="button" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        <button type="button" onClick={testConnection}>Test connection</button>
        <button type="button" onClick={discoverModels}>Discover models</button>
      </div>
      <output className="status-output">{status}</output>
      {models.length > 0 ? <ul className="model-list">{models.map((model) => <li key={model}>{model}</li>)}</ul> : null}
    </form>
  );
}
