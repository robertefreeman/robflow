import { InferenceSettingsForm } from "./InferenceSettingsForm";

export default function InferenceSettingsPage() {
  return (
    <main className="page settings-page">
      <section className="panel">
        <p className="eyebrow">Settings</p>
        <h1>Inference endpoint</h1>
        <p>Configure the global OpenAI-compatible endpoint used by future workers and agent nodes.</p>
        <InferenceSettingsForm />
        <p className="note">The API never returns stored secrets. API keys are encrypted with INFERENCE_CONFIG_ENCRYPTION_KEY before persistence.</p>
      </section>
    </main>
  );
}
