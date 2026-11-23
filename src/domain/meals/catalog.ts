import { readFile } from "node:fs/promises";
import { z } from "zod";

export type Product = {
  name: string;
  row?: Record<string, unknown>;
  evidence?: string;
  listedYuan?: number;
  category?: string;
};
const mapping = z.array(
  z
    .object({
      productCode: z.string().min(1),
      menuName: z.string().min(1),
      nutritionName: z.string().min(1),
      nutritionDescription: z.string().nullable(),
      evidence: z.string().min(1),
    })
    .strict(),
);

// 配置由运营根据官方规格维护；来自对话的名称或说明不能覆盖此表。
export async function loadMappings(path = process.env.MCD_NUTRITION_MAPPING) {
  return path ? mapping.parse(JSON.parse(await readFile(path, "utf8"))) : [];
}

export function combinations(
  catalog: Map<string, Product>,
  mustInclude: string[],
) {
  const entries = [...catalog];
  const role = (p: Product) => {
    const label = p.category ?? "";
    if (/套餐/.test(p.name)) return "meal";
    if (/汉堡|麦满分|主食/.test(label) || /堡|麦满分|卷饼/.test(p.name))
      return "main";
    if (/饮品|咖啡/.test(label) || /可乐|牛奶|咖啡|豆浆|雪碧|红茶/.test(p.name))
      return "drink";
    if (/小食|配餐/.test(label) || /薯条|薯饼|麦乐鸡/.test(p.name))
      return "side";
    return "other";
  };
  const select = (code: string) => ({ productCode: code, quantity: 1 });
  const priorities = (p: Product) =>
    mustInclude.some((word) => p.name.includes(word)) ? 0 : 1;
  const options = (kind: string) =>
    entries
      .filter(([, p]) => role(p) === kind)
      .sort(
        (a, b) =>
          priorities(a[1]) - priorities(b[1]) ||
          (a[1].listedYuan ?? Infinity) - (b[1].listedYuan ?? Infinity),
      )
      .slice(0, 8);
  const sides = options("side"),
    drinks = options("drink");
  const baskets = entries.map(([code]) => [select(code)]);
  const paired = [];
  for (const [main] of options("main")) {
    for (const [extra] of [...sides, ...drinks])
      paired.push([select(main), select(extra)]);
    for (const [side] of sides)
      for (const [drink] of drinks)
        paired.push([select(main), select(side), select(drink)]);
  }
  // 混排独立商品与组合，使默认的有限次算价也可以比较不同搭配。
  return [
    ...baskets.slice(0, 1),
    ...paired.slice(0, 1),
    ...baskets.slice(1, 2),
    ...paired.slice(1, 2),
    ...baskets.slice(2),
    ...paired.slice(2),
  ];
}
