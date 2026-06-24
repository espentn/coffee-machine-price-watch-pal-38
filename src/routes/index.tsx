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

type Category = "coffee" | "air" | "vacuum";

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
  category: Category;
  is_refurbished: boolean;
};


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Home Watch — Philips Price Tracker" },
      { name: "description", content: "Live price-drop and stock alerts for Philips espresso machines, air purifiers and vacuums." },
      { property: "og:title", content: "Home Watch" },
      { property: "og:description", content: "Live price-drop and stock alerts across Philips Norway." },
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

  // Best Buy picks per category
  function pickBest(cat: Category, opts?: { minDrinks?: number }): { p: Product; discount: number } | null {
    const eligible = products.filter(
      (p) =>
        p.category === cat &&
        p.status === "active" &&
        p.in_stock &&
        p.price != null &&
        (opts?.minDrinks ? (p.drink_count ?? 0) >= opts.minDrinks : true)
    );
    if (eligible.length === 0) return null;
    const prices = eligible.map((p) => p.price as number);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const scored = eligible.map((p) => {
      const priceScore = maxP === minP ? 1 : 1 - ((p.price as number) - minP) / (maxP - minP);
      const discount = p.rr_price && p.price && p.price < p.rr_price
        ? (p.rr_price - p.price) / p.rr_price
        : 0;
      let extra = 0;
      if (cat === "coffee" && p.drink_count) {
        extra = Math.min(p.drink_count / 12, 1) * 0.35;
      }
      const score = priceScore * 0.45 + discount * 0.25 + extra;
      return { p, score, discount: Math.round(discount * 1000) / 10 };
    });
    scored.sort((a, b) => b.score - a.score);
    return { p: scored[0].p, discount: scored[0].discount };
  }

  const coffeePick = useMemo(() => pickBest("coffee", { minDrinks: 7 }), [products]);
  const airPick = useMemo(() => pickBest("air"), [products]);
  const vacuumPick = useMemo(() => pickBest("vacuum"), [products]);

  // Top lists per category — scored same way, top 6
  function topList(cat: Category, limit = 6): { p: Product; discount: number }[] {
    const eligible = products.filter((p) => p.category === cat && p.status === "active" && p.price != null);
    if (eligible.length === 0) return [];
    const prices = eligible.map((p) => p.price as number);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const scored = eligible.map((p) => {
      const priceScore = maxP === minP ? 1 : 1 - ((p.price as number) - minP) / (maxP - minP);
      const discount = p.rr_price && p.price && p.price < p.rr_price
        ? (p.rr_price - p.price) / p.rr_price
        : 0;
      let extra = 0;
      if (cat === "coffee" && p.drink_count) extra = Math.min(p.drink_count / 12, 1) * 0.3;
      const stockPenalty = p.in_stock ? 0 : -0.5;
      const score = priceScore * 0.45 + discount * 0.25 + extra + stockPenalty;
      return { p, score, discount: Math.round(discount * 1000) / 10 };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
  const coffeeTop = useMemo(() => topList("coffee"), [products]);
  const airTop = useMemo(() => topList("air"), [products]);
  const vacuumTop = useMemo(() => topList("vacuum"), [products]);

  // Watchlist: Air Performer (any) + refurbished vacuums
  const watchlist = useMemo(() => {
    return products.filter((p) => {
      if (p.status !== "active") return false;
      const isAirPerformer = p.name.toLowerCase().includes("air performer");
      const isRefurbVacuum = p.category === "vacuum" && p.is_refurbished;
      return isAirPerformer || isRefurbVacuum;
    });
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
              <span className="gold-text">Home</span> Watch
            </h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Tracking Philips Norway across espresso, air &amp; vacuums. Alerts fire on every price drop, new arrival,
              removal and stock change — here and on Telegram.
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

        {/* Top picks: three columns */}
        {(coffeePick || airPick || vacuumPick) && (
          <section className="mb-10">
            <div className="mb-5">
              <div className="mb-1 inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                <span style={{ color: "var(--gold)" }}>★</span> Top picks right now
              </div>
              <h2 className="text-2xl md:text-3xl font-semibold">
                <span className="gold-text">Coffee</span>, <span className="gold-text">Air</span> &amp; <span className="gold-text">Vacuum</span>
              </h2>
            </div>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
              <TopPickCard pick={coffeePick} category="coffee" />
              <TopPickCard pick={airPick} category="air" />
              <TopPickCard pick={vacuumPick} category="vacuum" />
            </div>
          </section>
        )}

        {/* Watchlist */}
        {watchlist.length > 0 && (
          <section className="mb-12">
            <div className="mb-4">
              <div className="mb-1 inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                <span>👀</span> Watchlist
              </div>
              <h2 className="text-xl md:text-2xl font-semibold">
                Air Performer &amp; refurbished vacuums
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Calling these out the moment they drop in price — especially renovated stock.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {watchlist.map((p) => {
                const discount = p.rr_price && p.price && p.price < p.rr_price
                  ? Math.round(((p.rr_price - p.price) / p.rr_price) * 1000) / 10
                  : 0;
                return (
                  <a
                    key={p.code}
                    href={p.product_url ?? "#"}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="glass-card flex gap-3 rounded-2xl p-4"
                  >
                    <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-secondary/40">
                      {p.image_url ? (
                        <img src={p.image_url} alt={p.name} loading="lazy" className="h-full w-auto object-contain p-1" />
                      ) : (
                        <span className="text-2xl">{p.category === "vacuum" ? "🧹" : "🌬️"}</span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1">
                        {p.is_refurbished && (
                          <span className="rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
                            style={{ color: "oklch(0.85 0.12 150)", background: "color-mix(in oklch, oklch(0.78 0.12 150) 18%, transparent)" }}>
                            ♻ Refurb
                          </span>
                        )}
                        {p.name.toLowerCase().includes("air performer") && (
                          <span className="rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
                            style={{ color: "var(--gold)", background: "color-mix(in oklch, var(--gold) 18%, transparent)" }}>
                            ★ Air Performer
                          </span>
                        )}
                      </div>
                      <h3 className="mt-1 line-clamp-2 text-xs font-semibold leading-snug">{p.name}</h3>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className="rounded-full bg-secondary/60 px-2 py-0.5 font-semibold">{fmtPrice(p.price)}</span>
                        {discount > 0 && (
                          <span className="rounded-full px-2 py-0.5 font-semibold"
                            style={{ color: "var(--gold)", background: "color-mix(in oklch, var(--gold) 14%, transparent)" }}>
                            −{discount}%
                          </span>
                        )}
                        {!p.in_stock && <span className="text-muted-foreground">· sold out</span>}
                      </div>
                    </div>
                  </a>
                );
              })}
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


        {/* Category top lists */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <CategoryTopList title="Coffee" emoji="☕" items={coffeeTop} />
          <CategoryTopList title="Air" emoji="🌬️" items={airTop} />
          <CategoryTopList title="Vacuum" emoji="🧹" items={vacuumTop} />
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

function TopPickCard({
  pick,
  category,
}: {
  pick: { p: Product; discount: number } | null;
  category: Category;
}) {
  const meta = {
    coffee: { label: "Coffee", emoji: "☕", tagline: "Best espresso value" },
    air: { label: "Air", emoji: "🌬️", tagline: "Best air purifier value" },
    vacuum: { label: "Vacuum", emoji: "🧹", tagline: "Best vacuum value" },
  }[category];

  if (!pick) {
    return (
      <div className="best-buy-card flex h-full flex-col items-center justify-center rounded-3xl p-8 text-center">
        <span className="text-5xl">{meta.emoji}</span>
        <div className="mt-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">{meta.label}</div>
        <p className="mt-2 text-sm text-muted-foreground">No in-stock picks yet — run a check.</p>
      </div>
    );
  }
  const { p, discount } = pick;
  return (
    <a
      href={p.product_url ?? "#"}
      target="_blank"
      rel="noreferrer noopener"
      className="best-buy-card relative flex h-full flex-col gap-4 overflow-hidden rounded-3xl p-6"
    >
      <span
        className="absolute right-4 top-4 z-10 rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wider"
        style={{ background: "var(--gold)", color: "#1a1108" }}
      >
        ★ {meta.label} Pick
      </span>
      <div className="flex h-44 w-full items-center justify-center rounded-2xl bg-secondary/40">
        {p.image_url ? (
          <img src={p.image_url} alt={p.name} loading="lazy" className="h-full w-auto object-contain p-3" />
        ) : (
          <span className="text-6xl">{meta.emoji}</span>
        )}
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {meta.tagline} · {p.code}
        </div>
        <h3 className="mt-1 text-lg md:text-xl font-semibold leading-tight">{p.name}</h3>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-secondary/70 px-3 py-1.5 text-base font-bold">
            {fmtPrice(p.price)}
          </span>
          {p.rr_price != null && p.price != null && p.price < p.rr_price && (
            <span className="rounded-full bg-secondary/40 px-2.5 py-1.5 text-xs text-muted-foreground line-through">
              {fmtPrice(p.rr_price)}
            </span>
          )}
          {discount > 0 && (
            <span
              className="rounded-full px-2.5 py-1.5 text-xs font-bold"
              style={{ color: "var(--gold)", background: "color-mix(in oklch, var(--gold) 18%, transparent)" }}
            >
              −{discount}%
            </span>
          )}
        </div>
        {category === "coffee" && p.drink_count != null && (
          <div className="mt-3 text-xs text-muted-foreground">
            <span style={{ color: "var(--gold)" }}>☕</span> <strong className="text-foreground">{p.drink_count}</strong> drinks
          </div>
        )}
        {p.is_refurbished && (
          <div className="mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: "oklch(0.85 0.12 150)", background: "color-mix(in oklch, oklch(0.78 0.12 150) 16%, transparent)" }}>
            ♻ Refurbished
          </div>
        )}
      </div>
    </a>
  );
}

