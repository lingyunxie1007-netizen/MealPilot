import assert from "node:assert/strict";
import test from "node:test";
import {
  TOOL_NAMES,
  isWriteTool,
  unpack,
} from "../src/integrations/mcd/index.ts";
import { recommend } from "../src/domain/meals/index.ts";

test("公开文档样例保留千焦和千卡，嵌套错误不会当成成功", () => {
  const data =
    '[1]{productName,nutritionDescription,energyKj,energyKcal}:\n  "餐品,中份",null,1288,308';
  assert.deepEqual(
    unpack({
      content: [
        { type: "text", text: JSON.stringify({ success: true, data }) },
      ],
    }),
    [
      {
        productName: "餐品,中份",
        nutritionDescription: null,
        energyKj: 1288,
        energyKcal: 308,
      },
    ],
  );
  assert.throws(() => unpack({ success: false, data: [] }));
  assert.equal(new Set(TOOL_NAMES).size, 35);
  assert.equal(TOOL_NAMES.filter(isWriteTool).length, 7);
});

for (const time of ["07:00", "12:00", "15:00", "18:00", "23:30"]) {
  test(time + " 按预约菜单、份数与当次含配送费报价过滤", async () => {
    const reservationDate = "2026-11-22 " + time;
    const call = async (name: string, p: Record<string, unknown>) => {
      if (name === "list-nutrition-foods")
        return [
          {
            productCode: "A",
            productName: "餐品",
            energyKcal: 100,
            energyKj: 420,
          },
        ];
      assert.equal(p.reservationDate, reservationDate);
      if (name === "query-meals")
        return { meals: { A: { name: "餐品" }, B: { name: "餐品" } } };
      if (name === "calculate-price")
        return { price: 2200, deliveryPrice: 600 };
      return [];
    };
    const request = {
      storeCode: "门店",
      orderType: 2,
      beType: 2,
      reservationDate,
      maxKcal: 210,
      budgetCents: 2200,
      baskets: [
        [{ productCode: "A", quantity: 2 }],
        [{ productCode: "B", quantity: 1 }],
      ],
    };
    const result = await recommend(call, request);
    assert.deepEqual(result.coverage, { matched: 1, total: 2 });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].nutrition.energyKcal, 200);
    assert.equal(
      (await recommend(call, { ...request, budgetCents: 2199 })).candidates
        .length,
      0,
    );
  });
}
test("必选与排除条件按整套匹配，并汇总主食和配餐", async () => {
  const rows = [
    { productName: "鸡腿堡", energyKcal: 300 },
    { productName: "小薯条", energyKcal: 150 },
    { productName: "可乐", energyKcal: 100 },
  ];
  const result = await recommend(async () => rows, {
    mustInclude: ["堡", "薯条"],
    exclude: ["可乐"],
    maxKcal: 450,
  });
  assert.deepEqual(
    result.candidates.map((c) => c.nutrition.energyKcal),
    [450],
  );
  assert.equal(unpack("001"), "001");
});

test("配置规格映射与门店券共同参与当次报价", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "mealpilot-mapping-"));
  const prior = process.env.MCD_NUTRITION_MAPPING;
  try {
    const path = join(dir, "verified.json");
    await writeFile(
      path,
      JSON.stringify([
        {
          productCode: "A",
          menuName: "中薯",
          nutritionName: "薯条",
          nutritionDescription: "中份",
          evidence: "测试规格核对记录",
        },
      ]),
    );
    process.env.MCD_NUTRITION_MAPPING = path;
    const call = async (name: string, args: Record<string, unknown>) => {
      if (name === "query-meals")
        return { meals: { A: { name: "中薯", currentPrice: "12" } } };
      if (name === "list-nutrition-foods")
        return [
          {
            productName: "薯条",
            nutritionDescription: "中份",
            energyKcal: 200,
          },
          {
            productName: "薯条",
            nutritionDescription: "大份",
            energyKcal: 350,
          },
        ];
      if (name === "query-store-coupons")
        return [
          {
            couponId: "id",
            couponCode: "token",
            products: [{ productCode: "A" }],
          },
        ];
      if (name === "calculate-price") {
        assert.deepEqual(args.items, [
          {
            productCode: "A",
            quantity: 1,
            couponCode: "token",
            couponId: "id",
          },
        ]);
        return { price: 850 };
      }
      return [];
    };
    const result = await recommend(call, {
      storeCode: "s",
      beType: 1,
      orderType: 1,
      maxKcal: 210,
      budgetCents: 850,
    });
    assert.deepEqual(result.candidates[0].evidence, ["测试规格核对记录"]);
    assert.equal(result.candidates[0].priceCents, 850);
  } finally {
    if (prior === undefined) delete process.env.MCD_NUTRITION_MAPPING;
    else process.env.MCD_NUTRITION_MAPPING = prior;
    await rm(dir, { recursive: true });
  }
});
