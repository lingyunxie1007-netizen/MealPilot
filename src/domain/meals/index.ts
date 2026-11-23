import { combinations, loadMappings, type Product } from "./catalog.ts";
import { z } from "zod";

const item = z
  .object({
    productCode: z.string().min(1),
    quantity: z.number().int().min(1).max(99),
  })
  .passthrough();
const identifier = z.union([z.string(), z.number().int()]);
export const mealRequest = z
  .object({
    storeCode: z.string().optional(),
    beCode: z.string().optional(),
    beType: identifier.optional(),
    orderType: identifier.optional(),
    reservationDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
      .optional(),
    maxKcal: z.number().nonnegative().optional(),
    minProtein: z.number().nonnegative().optional(),
    budgetCents: z.number().int().nonnegative().optional(),
    avoidAllergens: z.array(z.string()).default([]),
    mustInclude: z.array(z.string().min(1)).default([]),
    exclude: z.array(z.string().min(1)).default([]),
    search: z.string().default(""),
    sort: z.enum(["price", "protein", "energy"]).optional(),
    baskets: z.array(z.array(item).min(1).max(20)).max(5).optional(),
  })
  .strict();
type Row = Record<string, any>;
type Call = (name: string, args: Record<string, unknown>) => Promise<any>;
const numeric = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;
const fields = [
  "energyKcal",
  "energyKj",
  "protein",
  "fat",
  "carbohydrate",
  "sodium",
  "calcium",
] as const;

export async function recommend(call: Call, input: unknown) {
  const args = mealRequest.parse(input);
  const { storeCode, beCode, beType, orderType, reservationDate } = args;
  const context = Object.fromEntries(
    Object.entries({
      storeCode,
      beCode,
      beType,
      orderType,
      reservationDate,
    }).filter(([, v]) => v !== undefined),
  );
  if (storeCode && (!orderType || !beType))
    throw new Error("请指定就餐方式与业务类型");
  const rows: Row[] = await call("list-nutrition-foods", {});
  if (!Array.isArray(rows)) throw new Error("营养表格式异常");
  const menu = storeCode ? await call("query-meals", context) : undefined;
  const issues = new Set<string>();
  const catalog = new Map<string, Product>();
  if (storeCode) {
    const mappings = await loadMappings();
    const category = new Map<string, string>();
    for (const group of menu?.categories ?? [])
      for (const ref of group.meals ?? [])
        category.set(String(ref.code), group.name);
    for (const [code, product] of Object.entries<Row>(menu?.meals ?? {})) {
      let matches = rows.filter(
        (r) =>
          r.productCode != null &&
          String(r.productCode) === code &&
          r.productName === product.name,
      );
      // 标准营养表常常只有名称。没有规格映射证据时保留未知。
      const verified = mappings.filter(
        (m) => m.productCode === code && m.menuName === product.name,
      );
      let evidence = "官方商品编码与规格名称";
      if (!matches.length && verified.length === 1) {
        const m = verified[0];
        matches = rows.filter(
          (r) =>
            r.productName === m.nutritionName &&
            r.nutritionDescription === m.nutritionDescription,
        );
        evidence = m.evidence;
      }
      const listedYuan =
        typeof product.currentPrice === "string" &&
        /^\d+(\.\d+)?$/.test(product.currentPrice)
          ? Number(product.currentPrice)
          : undefined;
      catalog.set(code, {
        name: product.name,
        row: matches.length === 1 ? matches[0] : undefined,
        evidence: matches.length === 1 ? evidence : undefined,
        listedYuan,
        category: category.get(code),
      });
    }
  } else {
    rows.forEach((r, i) =>
      catalog.set(String(i), {
        name: r.productName,
        row: r,
        evidence: "官方标准营养表",
      }),
    );
  }
  const baskets = args.baskets ?? combinations(catalog, args.mustInclude);
  type Candidate = {
    items: z.infer<typeof item>[];
    names: string[];
    nutrition: Record<string, number | null>;
    priceCents: number | null;
    quote: any;
    source: string;
    details: Record<string, unknown>;
    evidence: (string | null)[];
  };
  const candidates: Candidate[] = [];
  for (const items of baskets) {
    const products = items.map((i) => catalog.get(i.productCode));
    if (products.some((p) => !p)) {
      issues.add("指定餐品未出现在目标菜单中");
      continue;
    }
    const names = products.map((p) => p!.name);
    if (
      !names.some((n) => n.includes(args.search)) ||
      args.mustInclude.some((w) => !names.some((n) => n.includes(w))) ||
      args.exclude.some((w) => names.some((n) => n.includes(w)))
    )
      continue;
    const nutrition: Record<string, number | null> = {};
    // 含定制、替换或用券的条目只保留已核实的报价。
    for (const key of fields) {
      let total: number | null = 0;
      for (const [i, selection] of items.entries()) {
        const value = numeric(products[i]?.row?.[key]);
        if (
          value === null ||
          Object.keys(selection).some(
            (k) =>
              !["productCode", "quantity", "couponCode", "couponId"].includes(
                k,
              ),
          )
        ) {
          total = null;
          break;
        }
        total += value * selection.quantity;
      }
      nutrition[key] = total;
    }
    if (args.avoidAllergens.length) {
      issues.add("缺少相应过敏原证据");
      continue;
    }
    if (
      args.maxKcal !== undefined &&
      (nutrition.energyKcal === null || nutrition.energyKcal > args.maxKcal)
    ) {
      issues.add("热量超限或规格尚未核实");
      continue;
    }
    if (
      args.minProtein !== undefined &&
      (nutrition.protein === null || nutrition.protein < args.minProtein)
    ) {
      issues.add("蛋白质不足或规格尚未核实");
      continue;
    }
    candidates.push({
      items,
      names,
      details: {},
      evidence: products.map((p) => p?.evidence ?? null),
      nutrition,
      priceCents: null,
      quote: null,
      source: storeCode
        ? "query-meals + list-nutrition-foods"
        : "list-nutrition-foods",
    });
  }
  const rank = (c: Candidate) =>
    args.sort === "protein"
      ? -(c.nutrition.protein ?? -Infinity)
      : args.sort === "energy"
        ? (c.nutrition.energyKcal ?? Infinity)
        : 0;
  const estimate = (c: Candidate) =>
    c.items.reduce(
      (sum, i) =>
        sum + (catalog.get(i.productCode)?.listedYuan ?? Infinity) * i.quantity,
      0,
    );
  candidates.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (args.sort === "price" || args.budgetCents !== undefined
        ? estimate(a) - estimate(b)
        : 0),
  );
  const shortlist = candidates.slice(0, 5);
  const offers: Record<string, unknown> = {};
  if (storeCode && shortlist.length) {
    for (const name of ["query-store-coupons", "query-promotions"]) {
      try {
        offers[name] = await call(name, context);
      } catch {
        issues.add(name + " 查询失败");
      }
    }
    const detailCache = new Map<string, unknown>();
    for (const candidate of shortlist) {
      for (const [index, selection] of candidate.items.entries()) {
        if (
          !/套餐/.test(candidate.names[index]) &&
          !selection.roundList &&
          !selection.modification
        )
          continue;
        if (!detailCache.has(selection.productCode)) {
          try {
            detailCache.set(
              selection.productCode,
              await call("query-meal-detail", {
                ...context,
                code: selection.productCode,
              }),
            );
          } catch {
            detailCache.set(selection.productCode, null);
            issues.add("套餐替换选项待核实");
          }
        }
        candidate.details[selection.productCode] = detailCache.get(
          selection.productCode,
        );
      }
    }
    const couponList = offers["query-store-coupons"];
    for (const candidate of shortlist) {
      // 每套候选独立试算，每张券在同一套中最多使用一次。
      const used = new Set(
        candidate.items.map((i) => i.couponCode).filter(Boolean),
      );
      if (Array.isArray(couponList))
        candidate.items = candidate.items.map((i) => {
          if (i.couponCode || i.couponId || i.quantity !== 1) return i;
          const coupon = couponList.find(
            (c) =>
              typeof c?.couponCode === "string" &&
              typeof c.couponId === "string" &&
              !used.has(c.couponCode) &&
              c.products?.some((p: Row) => p.productCode === i.productCode),
          );
          if (!coupon) return i;
          used.add(coupon.couponCode);
          return {
            ...i,
            couponCode: coupon.couponCode,
            couponId: coupon.couponId,
          };
        });
      try {
        candidate.quote = await call("calculate-price", {
          ...context,
          items: candidate.items,
        });
        const price = numeric(candidate.quote?.price);
        if (price !== null && Number.isSafeInteger(price))
          candidate.priceCents = price;
      } catch {
        /* 可售菜单和营养依据仍可展示。 */
      }
      if (candidate.priceCents === null) issues.add("实付价格待核实");
    }
  }
  const withinBudget = shortlist.filter(
    (c) =>
      args.budgetCents === undefined ||
      (c.priceCents !== null && c.priceCents <= args.budgetCents),
  );
  if (withinBudget.length < shortlist.length)
    issues.add("报价超出预算或缺少实付价格");
  if (args.sort === "price")
    withinBudget.sort(
      (a, b) => (a.priceCents ?? Infinity) - (b.priceCents ?? Infinity),
    );
  if (!candidates.length && !issues.size) issues.add("当前条件下未找到餐品");
  return {
    candidates: withinBudget.slice(0, 3),
    issues: [...issues],
    offers,
    context,
    coverage: {
      matched: [...catalog.values()].filter((v) => v.row).length,
      total: catalog.size,
    },
  };
}
