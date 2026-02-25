"use client";

import Link from "next/link";
import React, { JSX, useEffect, useState } from "react";

import { LOCAL_PREF_KEYS, readFirstStoredString, writeStoredString } from "../../../lib/local-preferences";
import styles from "../page.module.css";

const SHARED_EID_KEYS = [LOCAL_PREF_KEYS.sharedEid, LOCAL_PREF_KEYS.legacyEid] as const;

export default function XpGeDiagnosticsPage(): JSX.Element {
  const [eid, setEID] = useState<string>("");
  const [status, setStatus] = useState<number | null>(null);
  const [responseText, setResponseText] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  useEffect(() => {
    const savedEid = readFirstStoredString(SHARED_EID_KEYS);
    if (savedEid) {
      setEID(savedEid);
    }
  }, []);

  useEffect(() => {
    writeStoredString(SHARED_EID_KEYS, eid.trim());
  }, [eid]);

  async function runDiagnostics(): Promise<void> {
    if (!eid.trim()) {
      setError("Please enter your Egg Inc. ID before running diagnostics.");
      return;
    }

    setError(null);
    setStatus(null);
    setResponseText("");
    setIsLoading(true);
    try {
      const response = await fetch(`/api/inventory?eid=${encodeURIComponent(eid)}`);
      setStatus(response.status);
      const text = await response.text();
      try {
        setResponseText(JSON.stringify(JSON.parse(text), null, 2));
      } catch {
        setResponseText(text);
      }
      if (!response.ok) {
        setError("The API returned a non-success status.");
      }
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Unable to reach the API.";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="page">
      <div className="panel">
        <h1 style={{ margin: "0 0 6px" }}>XP + GE Craft Optimizer Diagnostics</h1>
        <p className="muted" style={{ margin: 0 }}>
          Calls the native `/api/inventory` endpoint and shows raw response payload.
        </p>

        <div className={styles.inputSection}>
          <label htmlFor="diagEidInput">EID</label>
          <input
            id="diagEidInput"
            type="text"
            value={eid}
            onChange={(event) => setEID(event.target.value)}
            onPaste={(event) => {
              event.preventDefault();
              setEID(event.clipboardData.getData("text"));
            }}
            placeholder="EI123..."
          />
          <button onClick={runDiagnostics} disabled={isLoading}>
            {isLoading ? "Running..." : "Run diagnostics"}
          </button>
        </div>

        {error && <div className={styles.errorBox}>Diagnostics error: {error}</div>}
        {status !== null && (
          <p className={styles.footnote} style={{ marginTop: 8 }}>
            HTTP status: {status}
          </p>
        )}
        {responseText && (
          <pre
            style={{
              marginTop: 10,
              border: "1px solid var(--stroke)",
              borderRadius: 10,
              padding: 10,
              background: "var(--card)",
              overflowX: "auto",
              fontSize: 12,
              lineHeight: 1.4,
              whiteSpace: "pre-wrap",
            }}
          >
            {responseText}
          </pre>
        )}

        <div className={styles.pageLinks}>
          <Link href="/xp-ge-craft" className="subtle-link">
            Back to optimizer
          </Link>
          <Link href="/" className="subtle-link">
            Back to menu
          </Link>
        </div>
      </div>
    </main>
  );
}
