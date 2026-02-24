import Link from "next/link";

export default function ShipTimerMigrationPage() {
  return (
    <main className="page">
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>Ship Timer Migration</h1>
        <p className="muted">
          This route is reserved for moving the ship timer utility into this unified app.
        </p>
        <p>
          Current production tool: <a href="https://ship-timer.netlify.app" target="_blank" rel="noreferrer">ship-timer.netlify.app</a>
        </p>
        <Link href="/">Back to menu</Link>
      </div>
    </main>
  );
}
