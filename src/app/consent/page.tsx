"use client";
import { useEffect, useState } from "react";
import { ArrowRight, Check, ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Brand } from "@/components/brand";

export default function Consent() {
  const [name, setName] = useState("Application");
  const [clientId, setClientId] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const id = query.get("client_id") || "";
    setClientId(id);
    setScopes((query.get("scope") || "").split(" "));
    authClient.oauth2
      .publicClient({ query: { client_id: id } })
      .then((result) => {
        if (result.data?.client_name) setName(result.data.client_name);
        if (result.error)
          setError(
            "Your sign-in session is required. Restart the connection from your AI app.",
          );
      });
  }, []);
  async function decide(accept: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await authClient.oauth2.consent({ accept });
      if (result.error) throw new Error(result.error.message);
      if (result.data?.url) window.location.assign(result.data.url);
      else window.location.assign("/");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Connection failed.");
      setBusy(false);
    }
  }
  return (
    <main className="consent-layout">
      <Brand />
      <section className="consent-card">
        <span className="consent-icon">
          <ShieldCheck size={30} />
        </span>
        <div className="eyebrow">CONNECT AN APPLICATION</div>
        <h1>
          Let {name} use
          <br />
          your Deaddrop?
        </h1>
        <p>You’re giving this application access to your shared workspace.</p>
        <div className="permission-list">
          {scopes.includes("deaddrop:read") && (
            <div>
              <Check size={17} /> Read notes and download attachments
            </div>
          )}
          {scopes.includes("deaddrop:write") && (
            <div>
              <Check size={17} /> Leave notes, reply, and upload files
            </div>
          )}
          {scopes.includes("offline_access") && (
            <div>
              <Check size={17} /> Stay connected between sessions
            </div>
          )}
          {scopes.some((s) => ["openid", "profile", "email"].includes(s)) && (
            <div>
              <Check size={17} /> Read your account identity
            </div>
          )}
        </div>
        <div className="client-identity">
          <span>APPLICATION ID</span>
          <code>{clientId}</code>
        </div>
        <p className="small">
          You can revoke this connection from your admin UI.
        </p>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="button-row">
          <button
            className="button"
            disabled={busy}
            onClick={() => decide(false)}
          >
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || !clientId}
            onClick={() => decide(true)}
          >
            Allow connection <ArrowRight size={16} />
          </button>
        </div>
      </section>
    </main>
  );
}
