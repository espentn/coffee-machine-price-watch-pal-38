import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type Alert = {
  id: string;
  type: string;
  product_code: string | null;
  product_name: string;
  message: string;
  price: number | null;
  old_price: number | null;
  rr_price: number | null;
  discount_pct: number | null;
  created_at: string;
};

type Product = {
  code: string;
  name: string;
  price: number | null;
  rr_price: number | null;
  in_stock: boolean;
  was_below_rrp: boolean;
  status: string;
  last_checked_at: string;
  drink_count: number | null;
  image_url: string | null;
  product_url: string | null;
};


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Espresso Watch — Philips Price Tracker" },
      { name: "description", content: "Live price-drop and stock alerts for Philips helautomatisk espressomaskin." },
      { property: "og:title", content: "Espresso Watch" },
      { property: "og:description", content: "Live price-drop and stock alerts for Philips espresso machines." },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap" },
    ],
  }),
  component: Dashboard,
});

const TYPE_META: Record<string, { label: string; color: string; icon: string }> = {
  new: { label: "New arrival", color: "oklch(0.78 0.12 150)", icon: "🆕" },
  price_drop: { label: "Price drop", color: "oklch(0.78 0.10 80)", icon: "📉" },
  sale_started: { label: "Sale started", color: "oklch(0.72 0.18 30)", icon: "🔥" },
  back_in_stock: { label: "Back in stock", color: "oklch(0.78 0.12 150)", icon: "✅" },
  sold_out: { label: "Sold out", color: "oklch(0.65 0.15 25)", icon: "❌" },
  removed: { label: "Removed", color: "oklch(0.55 0.04 50)", icon: "🗑️" },
};

function fmtPrice(v: number | null | undefined) {
  if (v == null) return "—";
  return `${Number(v).toLocaleString("nb-NO")} kr`;
}

function timeAgo(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function Dashboard() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [checking, setChecking] = useState(false);
  const [lastCheck, setLastCheck] = useState<string | null>(null);

  useEffect(() => {
    void load();
    const channel = supabase
      .channel("alerts-feed")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "alerts" }, (payload) => {
        const a = payload.new as Alert;
        setAlerts((prev) => [a, ...prev].slice(0, 100));
        const meta = TYPE_META[a.type] ?? { label: a.type, icon: "•" };
        toast(`${meta.icon} ${a.product_name}`, { description: a.message });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "products" }, () => {
        void loadProducts();
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, []);

  async function load() {
    await Promise.all([loadAlerts(), loadProducts()]);
  }
  async function loadAlerts() {
    const { data } = await supabase.from("alerts").select("*").order("created_at", { ascending: false }).limit(100);
    if (data) setAlerts(data as Alert[]);
  }
  async function loadProducts() {
    const { data } = await supabase.from("products").select("*").order("name");
    if (data) setProducts(data as Product[]);
  }

  async function checkNow() {
    setChecking(true);
    try {
      const res = await fetch("/api/public/check-prices", { method: "POST" });
      const json = await res.json();
      if (json.ok) {
        toast.success("Check complete", { description: `${json.products_checked} products • ${json.alerts} new alert(s)` });
        setLastCheck(new Date().toISOString());
        await load();
      } else {
        toast.error("Check failed", { description: json.error });
      }
    } catch (e: any) {
      toast.error("Check failed", { description: e?.message });
    } finally {
      setChecking(false);
    }
  }

  const stats = useMemo(() => {
    const active = products.filter((p) => p.status === "active").length;
    const onSale = products.filter((p) => p.was_below_rrp && p.status === "active").length;
    const outOfStock = products.filter((p) => !p.in_stock && p.status === "active").length;
    return { active, onSale, outOfStock, alerts: alerts.length };
  }, [products, alerts]);

  // Best Buy picks: active, in stock, ≥7 drinks, scored by value
  const bestBuys = useMemo(() => {
    const eligible = products.filter(
      (p) =>
        p.status === "active" &&
        p.in_stock &&
        p.price != null &&
        (p.drink_count ?? 0) >= 7
    );
    if (eligible.length === 0) return [];
    const prices = eligible.map((p) => p.price as number);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const drinks = eligible.map((p) => p.drink_count ?? 0);
    const maxD = Math.max(...drinks);
    const scored = eligible.map((p) => {
      const priceScore = maxP === minP ? 1 : 1 - ((p.price as number) - minP) / (maxP - minP); // cheaper = higher
      const drinkScore = maxD ? (p.drink_count ?? 0) / maxD : 0;
      const discount = p.rr_price && p.price && p.price < p.rr_price
        ? (p.rr_price - p.price) / p.rr_price
        : 0;
      // Weighted: drinks 40%, price 35%, discount 25%
      const score = drinkScore * 0.4 + priceScore * 0.35 + discount * 0.25;
      return { p, score, discount: Math.round(discount * 1000) / 10 };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3);
  }, [products]);


  return (
    <div className="min-h-screen px-4 py-10 md:px-8 lg:px-12">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <header className="mb-10 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-secondary/40 px-3 py-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">
              <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-primary" />
              Live monitor
            </div>
            <h1 className="text-4xl md:text-5xl font-semibold leading-tight">
              <span className="gold-text">Espresso</span> Watch
            </h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Tracking <em>helautomatisk espressomaskin</em> on Philips Norway. Alerts fire on every price drop, new
              arrival, removal, and stock change — here and on Telegram.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {lastCheck && (
              <span className="text-xs text-muted-foreground">Last check {timeAgo(lastCheck)}</span>
            )}
            <button
              onClick={checkNow}
              disabled={checking}
              className="btn-gold rounded-full px-5 py-2.5 text-sm font-semibold disabled:opacity-60"
            >
              {checking ? "Checking…" : "Check now"}
            </button>
          </div>
        </header>

        {/* Best Buy */}
        {bestBuys.length > 0 && (
          <section className="mb-10">
            <div className="mb-4 flex items-end justify-between">
              <div>
                <div className="mb-1 inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                  <span style={{ color: "var(--gold)" }}>★</span> Best buy picks
                </div>
                <h2 className="text-xl font-semibold">
                  Top value <span className="gold-text">right now</span>
                </h2>
              </div>
              <span className="hidden text-xs text-muted-foreground md:block">
                Scored on price, discount &amp; drink variety (≥7 drinks)
              </span>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {bestBuys.map(({ p, discount }, i) => (
                <a
                  key={p.code}
                  href={p.product_url ?? "#"}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="best-buy-card group relative flex flex-col overflow-hidden rounded-2xl p-5 transition"
                >
                  {i === 0 && (
                    <span
                      className="absolute right-4 top-4 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider"
                      style={{ background: "var(--gold)", color: "#1a1108" }}
                    >
                      #1 Pick
                    </span>
                  )}
                  <div className="mb-4 flex h-32 items-center justify-center rounded-xl bg-secondary/30">
                    {p.image_url ? (
                      <img
                        src={p.image_url}
                        alt={p.name}
                        loading="lazy"
                        className="h-full w-auto object-contain p-2"
                      />
                    ) : (
                      <span className="text-3xl">☕</span>
                    )}
                  </div>
                  <h3 className="line-clamp-2 text-sm font-semibold leading-snug">{p.name}</h3>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-full bg-secondary/60 px-2.5 py-1 font-semibold">
                      {fmtPrice(p.price)}
                    </span>
                    {p.rr_price != null && p.price != null && p.price < p.rr_price && (
                      <span className="rounded-full bg-secondary/40 px-2.5 py-1 text-muted-foreground line-through">
                        {fmtPrice(p.rr_price)}
                      </span>
                    )}
                    {discount > 0 && (
                      <span
                        className="rounded-full px-2.5 py-1 font-semibold"
                        style={{ color: "var(--gold)", background: "color-mix(in oklch, var(--gold) 14%, transparent)" }}
                      >
                        −{discount}%
                      </span>
                    )}
                  </div>
                  <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <span style={{ color: "var(--gold)" }}>☕</span>
                      {p.drink_count} drinks
                    </span>
                    <span className="opacity-50">•</span>
                    <span>{p.code}</span>
                  </div>
                </a>
              ))}
            </div>
          </section>
        )}

        {/* Stats */}
        <div className="mb-10 grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Active products" value={stats.active} />
          <StatCard label="On sale" value={stats.onSale} accent />
          <StatCard label="Out of stock" value={stats.outOfStock} />
          <StatCard label="Recent alerts" value={stats.alerts} />
        </div>


        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.1fr_1fr]">
          {/* Alerts feed */}
          <section>
            <h2 className="mb-4 text-xl font-semibold">Alert feed</h2>
            <div className="space-y-3">
              {alerts.length === 0 && (
                <div className="glass-card rounded-2xl p-6 text-sm text-muted-foreground">
                  No alerts yet. Hit <span className="text-primary">Check now</span> to seed the tracker — the first run
                  records every product as a new arrival.
                </div>
              )}
              {alerts.map((a) => {
                const meta = TYPE_META[a.type] ?? { label: a.type, color: "var(--gold)", icon: "•" };
                return (
                  <article key={a.id} className="glass-card alert-enter rounded-2xl p-5">
                    <div className="flex items-start gap-4">
                      <div
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg"
                        style={{ background: `${meta.color} / 0.15`, backgroundColor: `color-mix(in oklch, ${meta.color} 18%, transparent)`, color: meta.color }}
                      >
                        {meta.icon}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] uppercase tracking-[0.16em]" style={{ color: meta.color }}>
                            {meta.label}
                          </span>
                          <span className="text-[10px] text-muted-foreground">• {timeAgo(a.created_at)}</span>
                        </div>
                        <h3 className="mt-1 truncate text-sm font-semibold text-foreground">{a.product_name}</h3>
                        <p className="mt-1 text-sm text-muted-foreground">{a.message}</p>
                        {(a.price != null || a.discount_pct != null) && (
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                            {a.price != null && (
                              <span className="rounded-full bg-secondary/60 px-2.5 py-1 font-medium text-foreground">
                                {fmtPrice(a.price)}
                              </span>
                            )}
                            {a.old_price != null && (
                              <span className="rounded-full bg-secondary/40 px-2.5 py-1 text-muted-foreground line-through">
                                {fmtPrice(a.old_price)}
                              </span>
                            )}
                            {a.discount_pct != null && (
                              <span className="rounded-full px-2.5 py-1 font-semibold" style={{ color: "var(--gold)", background: "color-mix(in oklch, var(--gold) 14%, transparent)" }}>
                                −{a.discount_pct}%
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          {/* Products */}
          <section>
            <h2 className="mb-4 text-xl font-semibold">Tracked products</h2>
            <div className="space-y-3">
              {products.length === 0 && (
                <div className="glass-card rounded-2xl p-6 text-sm text-muted-foreground">
                  Nothing tracked yet.
                </div>
              )}
              {products.map((p) => {
                const discount = p.rr_price && p.price && p.price < p.rr_price
                  ? Math.round(((p.rr_price - p.price) / p.rr_price) * 1000) / 10
                  : 0;
                const removed = p.status === "removed";
                return (
                  <div key={p.code} className="glass-card rounded-2xl p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <h3 className={`truncate text-sm font-semibold ${removed ? "text-muted-foreground line-through" : "text-foreground"}`}>
                          {p.name}
                        </h3>
                        <div className="mt-1 text-[11px] text-muted-foreground">{p.code}</div>
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                          <span className="rounded-full bg-secondary/60 px-2.5 py-1 font-semibold text-foreground">
                            {fmtPrice(p.price)}
                          </span>
                          {p.rr_price != null && p.price != null && p.price < p.rr_price && (
                            <span className="rounded-full bg-secondary/40 px-2.5 py-1 text-muted-foreground line-through">
                              {fmtPrice(p.rr_price)}
                            </span>
                          )}
                          {discount > 0 && (
                            <span className="rounded-full px-2.5 py-1 font-semibold" style={{ color: "var(--gold)", background: "color-mix(in oklch, var(--gold) 14%, transparent)" }}>
                              −{discount}%
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <Pill ok={p.in_stock && !removed} okLabel="In stock" badLabel={removed ? "Removed" : "Sold out"} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <footer className="mt-12 text-center text-xs text-muted-foreground">
          Brewed with care · Philips Norway public catalog
        </footer>
      </div>
    </div>
  );
}

function StatCard({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="glass-card rounded-2xl p-5">
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div className={`mt-2 font-display text-3xl font-semibold ${accent ? "gold-text" : "text-foreground"}`}>
        {value}
      </div>
    </div>
  );
}

function Pill({ ok, okLabel, badLabel }: { ok: boolean; okLabel: string; badLabel: string }) {
  return (
    <span
      className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider"
      style={{
        color: ok ? "oklch(0.85 0.12 150)" : "oklch(0.75 0.14 25)",
        background: ok ? "color-mix(in oklch, oklch(0.78 0.12 150) 14%, transparent)" : "color-mix(in oklch, oklch(0.65 0.15 25) 14%, transparent)",
      }}
    >
      {ok ? okLabel : badLabel}
    </span>
  );
}
