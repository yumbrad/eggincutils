import Image from "next/image";
import Link from "next/link";

import { MISSION_CRAFT_COPY } from "../lib/mission-craft-copy";
import { SHIP_TIMER_COPY } from "../lib/ship-timer-copy";
import { XP_GE_CRAFT_COPY } from "../lib/xp-ge-craft-copy";

const cards = [
  {
    href: "/mission-craft-planner",
    title: MISSION_CRAFT_COPY.title,
    description: MISSION_CRAFT_COPY.subtitle,
    longDescription: MISSION_CRAFT_COPY.longDescription,
  },
  {
    href: "/xp-ge-craft",
    title: XP_GE_CRAFT_COPY.title,
    description: XP_GE_CRAFT_COPY.subtitle,
    longDescription: XP_GE_CRAFT_COPY.longDescription,
  },
  {
    href: "/ship-timer",
    title: SHIP_TIMER_COPY.title,
    description: SHIP_TIMER_COPY.subtitle,
    longDescription: SHIP_TIMER_COPY.longDescription,
  },
];

export default function HomePage() {
  return (
    <main className="page">
      <div className="panel brand-panel home-brand-panel" style={{ marginBottom: 14 }}>
        <div className="home-hamster-accent" aria-hidden="true">
          <Image src="/media/hamster_egg_poly.png" alt="" width={768} height={1024} className="home-hamster" priority />
        </div>
        <div className="home-brand-copy">
          <p className="brand-kicker">Egg Inc. Chicken-to-consumer Layer Optimization Layer (C2C-LOL)™</p>
          <p className="brand-kicker">with Dilithium Enterprise Resource Planning (DERP™)</p>
          <h1 className="brand-title">techyum&apos;s eggy tools</h1>
        </div>
      </div>

      <section className="grid cards" aria-label="Utility links">
        {cards.map((card) => (
          <article key={card.href} className="card">
            <h2 className="tool-card-title">
              <Link href={card.href} style={{ textDecoration: "none" }}>
                {card.title}
              </Link>
            </h2>
            <p style={{ margin: 0 }} className="muted">
              {card.description}
            </p>
            {"longDescription" in card && card.longDescription && (
              <details className="info-disclosure">
                <summary className="subtle-info-link">More info</summary>
                <p className="muted">{card.longDescription}</p>
              </details>
            )}
          </article>
        ))}
      </section>
    </main>
  );
}
