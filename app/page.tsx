import Link from "next/link";

const cards = [
  {
    href: "/mission-craft-planner",
    title: "Mission + Craft Planner",
    description:
      "New optimizer: EID profile, inventory/craft history, target quantity, and GE vs time slider with 3-slot mission planning.",
  },
  {
    href: "/xp-ge-craft",
    title: "XP-GE Craft",
    description: "Migration route for the existing XP/GE crafting utility.",
  },
  {
    href: "/ship-timer",
    title: "Ship Timer",
    description: "Migration route for ship return timing utility.",
  },
];

export default function HomePage() {
  return (
    <main className="page">
      <div className="panel" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 34 }}>techyum&apos;s Egg, Inc. utils</h1>
        <p className="muted" style={{ margin: "8px 0 0" }}>
          Unified codebase in progress. Start with the new mission + crafting planner.
        </p>
      </div>

      <section className="grid cards" aria-label="Utility links">
        {cards.map((card) => (
          <Link key={card.href} href={card.href} className="card" style={{ textDecoration: "none" }}>
            <h2 style={{ margin: "0 0 6px", color: "var(--accent-2)" }}>{card.title}</h2>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              {card.href}
            </div>
            <p style={{ margin: 0 }} className="muted">
              {card.description}
            </p>
          </Link>
        ))}
      </section>
    </main>
  );
}
