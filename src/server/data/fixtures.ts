import { readFileSync } from "node:fs";

import { z } from "zod";

const productFixtureSchema = z.object({
  ProductName: z.string().min(1),
  SKU: z.string().min(1),
  Inventory: z.number().int().nonnegative(),
  Description: z.string(),
  Tags: z.array(z.string().min(1)),
});

const orderFixtureSchema = z.object({
  CustomerName: z.string().min(1),
  Email: z.string().email(),
  OrderNumber: z.string().min(1),
  ProductsOrdered: z.array(z.string().min(1)),
  Status: z.enum(["delivered", "in-transit", "fulfilled", "error"]),
  TrackingNumber: z.string().min(1).nullable(),
});

const productFixturesSchema = z.array(productFixtureSchema);
const orderFixturesSchema = z.array(orderFixtureSchema);

export type ProductFixture = z.infer<typeof productFixtureSchema>;
export type OrderFixture = z.infer<typeof orderFixtureSchema>;

function readJson(path: string): unknown {
  const json: unknown = JSON.parse(readFileSync(path, "utf8"));
  return json;
}

export function readProductFixtures(path: string): readonly ProductFixture[] {
  return productFixturesSchema.parse(readJson(path));
}

export function readOrderFixtures(path: string): readonly OrderFixture[] {
  return orderFixturesSchema.parse(readJson(path));
}
