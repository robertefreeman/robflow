import type { Metadata } from "next";
import "@xyflow/react/dist/style.css";
import "./styles.css";

export const metadata: Metadata = {
  title: "robflow",
  description: "Workflow automation foundation"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <nav className="top-nav" aria-label="Primary navigation">
          <a href="/">Home</a>
          <a href="/agents">Agents</a>
          <a href="/node-types">Node types</a>
          <a href="/settings/inference">Inference settings</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
