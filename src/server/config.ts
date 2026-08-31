import "dotenv/config";
import { resolve } from "node:path";
import { z } from "zod";

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_001),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_PATH: z.string().default("data/sierra.db"),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.enum(["gpt-4o", "gpt-4o-mini"]).default("gpt-4o"),
  SIERRA_DEMO_MODE: z.enum(["0", "1"]).default("0"),
});

export interface AppConfig {
  readonly port: number;
  readonly host: string;
  readonly databasePath: string;
  readonly ordersPath: string;
  readonly productsPath: string;
  readonly model: string;
  readonly apiKey: string | undefined;
  readonly demoMode: boolean;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    port: parsed.PORT,
    host: parsed.HOST,
    databasePath: resolve(parsed.DATABASE_PATH),
    ordersPath: resolve("CustomerOrders.json"),
    productsPath: resolve("ProductCatalog.json"),
    model: parsed.OPENAI_MODEL,
    apiKey: parsed.OPENAI_API_KEY,
    demoMode: parsed.SIERRA_DEMO_MODE === "1",
  };
}
