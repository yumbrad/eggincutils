import Link from "next/link";

export default function XpGeCraftMigrationPage() {
  return (
    <main className="page">
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>XP-GE Craft Migration</h1>
        <p className="muted">
          This route is reserved for moving the existing XP-GE utility into this unified app.
        </p>
        <p>
          Current production tool: <a href="https://xp-ge-craft.netlify.app/xp-ge-craft" target="_blank" rel="noreferrer">xp-ge-craft.netlify.app</a>
        </p>
        <Link href="/">Back to menu</Link>
      </div>
    </main>
  );
}
