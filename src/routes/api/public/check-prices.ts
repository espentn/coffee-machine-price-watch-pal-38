import { createFileRoute } from "@tanstack/react-router";

const BASE_URL = "https://www.home-appliances.philips/occ/v2/versuni-b2c-no/products/search";

type Category = "coffee" | "air" | "vacuum" | "robot_vacuum";

type CategoryConfig = {
  id: string;
  apiCategory: string;
  keywords: string[]; // lowercase substrings; product name must include at least one
  category: Category;
};

const CATEGORIES: CategoryConfig[] = [
  {
    id: "coffee",
    apiCategory: "COFFEEMAKERS_AND_KETTLES_CA",
    keywords: ["helautomatisk espressomaskin", "kaffemaskin", "espressomaskin"],
    category: "coffee",
  },
  {
    id: "air",
    apiCategory: "AIR_PURIFIER_CA",
    keywords: ["luftrenser", "air purifier", "air performer", "luftfukter", "humidifier"],
    category: "air",
  },
  {
    id: "vacuum-canister",
    apiCategory: "CANISTER_VACUUMS_SU",
    keywords: ["støvsuger", "vacuum"],
    category: "vacuum",
  },
  {
    id: "vacuum-robot",
    apiCategory: "ROBOT_VACUUMS_SU",
    keywords: ["robotstøvsuger", "robot vacuum", "robot vacuum cleaner", "robot støvsuger"],
    category: "robot_vacuum",
  },
];

type AlertRow = {
  type: string;
  product_code: string | null;
  product_name: string;
  message: string;
  price: number | null;
  old_price: number | null;
  rr_price: number | null;
  discount_pct: number | null;
  category: Category;
};

function calculateDiscount(current: number, rrp: number | null | undefined) {
  if (!rrp || rrp <= 0 || current >= rrp) return 0;
  return Math.round(((rrp - current) / rrp) * 1000) / 10;
}

function detectRefurbished(name: string) {
  const n = name.toLowerCase();
  return /\b(renover|refurb|outlet|brukt)/i.test(n);
}

async function sendTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.error("Telegram send failed", e);
  }
}

async function runCheck() {
  let supabaseAdmin: any = null;
  let db = new Map<string, any>();
  let foundCodes = new Set<string>();
  const alerts: AlertRow[] = [];

  try {
    const mod = await import("@/integrations/supabase/client.server");
    supabaseAdmin = mod.supabaseAdmin;
    const { data: existing } = await supabaseAdmin.from("products").select("*");
    (existing ?? []).forEach((p: any) => db.set(p.code, p));
  } catch (e: any) {
    console.warn("Supabase unavailable during price check", e?.message ?? e);
  }

  for (const cat of CATEGORIES) {
    let currentPage = 0;
    let totalPages = 1;

    while (currentPage < totalPages) {
      const params = new URLSearchParams({
        fields:
          "products(code,originalCode,name,purchasable,price(FULL),rrPrice(FULL),stock(FULL)),pagination(DEFAULT)",
        query: `:relevance:allCategories:${cat.apiCategory}`,
        pageSize: "24",
        country: "no",
        lang: "no_NO",
        curr: "NOK",
        currentPage: String(currentPage),
      });

      const res = await fetch(`${BASE_URL}?${params.toString()}`);
      if (!res.ok) {
        console.warn(`Philips API ${res.status} for category ${cat.id}`);
        break;
      }
      const data: any = await res.json();
      totalPages = data?.pagination?.totalPages ?? 1;
      const products: any[] = data?.products ?? [];

      for (const p of products) {
        const name: string = p.name ?? "";
        const code: string | undefined = p.originalCode;
        if (!code) continue;
        const lname = name.toLowerCase();
        if (!cat.keywords.some((k) => lname.includes(k))) continue;
        foundCodes.add(code);

        const price = p?.price?.value;
        const rr = p?.rrPrice?.value ?? null;
        const isPurchasable = p?.purchasable ?? true;
        const isRefurb = detectRefurbished(name);
        if (price == null) continue;

        const discount = calculateDiscount(price, rr);
        const isBelow = rr != null && price < rr;
        const prev = db.get(code);

        // Special hot-watch: Air Performer refurbished going on sale
        const isAirPerformer = lname.includes("air performer");

        if (!prev) {
          const status = isBelow ? `🔥 ON SALE (${discount}% off)` : "at RRP";
          const stockMsg = isPurchasable ? "" : " (SOLD OUT)";
          const refurbTag = isRefurb ? " ♻️ Refurbished" : "";
          alerts.push({
            type: "new",
            product_code: code,
            product_name: name,
            message: `🆕 NEW ARRIVAL — ${price} kr ${status}${stockMsg}${refurbTag}`,
            price, old_price: null, rr_price: rr, discount_pct: isBelow ? discount : null,
            category: cat.category,
          });
        } else {
          const prevStock = prev.in_stock;
          if (isPurchasable && !prevStock) {
            alerts.push({ type: "back_in_stock", product_code: code, product_name: name,
              message: `✅ BACK IN STOCK — available again`, price, old_price: null, rr_price: rr, discount_pct: null, category: cat.category });
          } else if (!isPurchasable && prevStock) {
            alerts.push({ type: "sold_out", product_code: code, product_name: name,
              message: `❌ SOLD OUT — no longer available`, price, old_price: null, rr_price: rr, discount_pct: null, category: cat.category });
          }

          const oldPrice = Number(prev.price);
          const previouslyBelow = prev.was_below_rrp;
          if (isBelow && !previouslyBelow) {
            const prefix = isAirPerformer && isRefurb ? "🌬️🔥 AIR PERFORMER REFURB DEAL" : "🔥 SALE STARTED";
            alerts.push({ type: "sale_started", product_code: code, product_name: name,
              message: `${prefix} — ${price} kr (${discount}% off RRP ${rr} kr)`,
              price, old_price: oldPrice, rr_price: rr, discount_pct: discount, category: cat.category });
          } else if (price < oldPrice) {
            const prefix = isAirPerformer && isRefurb ? "🌬️📉 AIR PERFORMER REFURB DROP" : "📉 PRICE DROP";
            alerts.push({ type: "price_drop", product_code: code, product_name: name,
              message: `${prefix} — Now ${price} kr (was ${oldPrice} kr)`,
              price, old_price: oldPrice, rr_price: rr, discount_pct: isBelow ? discount : null, category: cat.category });
          }
        }

        // Enrich with drink count + image (drink count only meaningful for coffee)
        let drinkCount: number | null = null;
        let imageUrl: string | null = null;
        let productUrl: string | null = null;
        try {
          const detailCode = code.replace(/\//g, "_");
          const detailRes = await fetch(
            `https://www.home-appliances.philips/occ/v2/versuni-b2c-no/products/${detailCode}?fields=FULL&lang=no_NO&curr=NOK`
          );
          if (detailRes.ok) {
            const detail: any = await detailRes.json();
            if (cat.id === "coffee") {
              const feats: any[] = detail?.productFeatures?.features ?? [];
              const drinkRegex = /(\d{1,2})[^\d]{0,60}?\b(drikker|drinks)\b/i;
              const nums: number[] = [];
              for (const f of feats) {
                const blob = [f?.name, f?.featureReferenceName, f?.featureShortDescription]
                  .filter(Boolean).join(" | ");
                const m = blob.match(drinkRegex);
                if (m) nums.push(parseInt(m[1], 10));
              }
              if (nums.length) drinkCount = Math.max(...nums);
            }

            imageUrl = detail?.primaryImage?.url
              ?? (detail?.images ?? []).find((i: any) => i?.imageType === "PRIMARY")?.url
              ?? null;
            productUrl = detail?.url
              ? `https://www.home-appliances.philips${detail.url}`
              : null;
          }
        } catch (e) {
          console.warn("detail fetch failed for", code, e);
        }

        if (supabaseAdmin) {
          await supabaseAdmin.from("products").upsert({
            code, name, price, rr_price: rr,
            in_stock: isPurchasable, was_below_rrp: isBelow,
            status: "active", last_checked_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            category: cat.category,
            is_refurbished: isRefurb,
            ...(drinkCount != null ? { drink_count: drinkCount } : {}),
            ...(imageUrl ? { image_url: imageUrl } : {}),
            ...(productUrl ? { product_url: productUrl } : {}),
          });
        }
      }

      currentPage += 1;
    }
  }

  // Detect removed
  if (supabaseAdmin) {
    for (const [code, prev] of db) {
      if (!foundCodes.has(code) && prev.status !== "removed") {
        alerts.push({ type: "removed", product_code: code, product_name: prev.name,
          message: `🗑️ REMOVED — ${prev.name} has been delisted`,
          price: prev.price, old_price: null, rr_price: prev.rr_price, discount_pct: null,
          category: (prev.category as Category) ?? "coffee" });
        await supabaseAdmin.from("products").update({ status: "removed", updated_at: new Date().toISOString() }).eq("code", code);
      }
    }

    if (alerts.length > 0) {
      await supabaseAdmin.from("alerts").insert(alerts);
    }
  }

  for (const a of alerts) {
    await sendTelegram(`<b>${a.product_name}</b>\n${a.message}`);
  }

  return { ok: true, alerts: alerts.length, products_checked: foundCodes.size, note: supabaseAdmin ? null : "Supabase not configured; products were not persisted." };
}

export const Route = createFileRoute("/api/public/check-prices")({
  server: {
    handlers: {
      POST: async () => {
        try {
          const result = await runCheck();
          return Response.json(result);
        } catch (e: any) {
          console.error("check-prices error", e);
          return Response.json({ ok: false, error: e?.message ?? "unknown" }, { status: 500 });
        }
      },
      GET: async () => {
        try {
          const result = await runCheck();
          return Response.json(result);
        } catch (e: any) {
          return Response.json({ ok: false, error: e?.message ?? "unknown" }, { status: 500 });
        }
      },
    },
  },
});
