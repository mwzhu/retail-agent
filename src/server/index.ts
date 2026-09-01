import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { loadConfig, type AppConfig } from "./config";
import { openSierraStore } from "./data/store";
import {
  createChatApplication,
  createOpenAIModelClient,
  createUnavailableModelClient,
} from "./agent/index";
import { registerRoutes } from "./routes";
import {
  createNdjsonTraceSink,
  noOpTraceSink,
  type AgentTraceSink,
} from "./agent/trace";

export interface ServerClock {
  now(): Date;
  monotonicNow(): number;
}

const systemClock: ServerClock = {
  now: () => new Date(),
  monotonicNow: () => performance.now(),
};

export async function buildServer(input: Readonly<{
  config?: AppConfig;
  clock?: ServerClock;
  trace?: AgentTraceSink;
  logger?: boolean;
}> = {}) {
  const config = input.config ?? loadConfig();
  const clock = input.clock ?? systemClock;
  const trace = input.trace
    ?? (config.tracePath === undefined
      ? noOpTraceSink
      : createNdjsonTraceSink(config.tracePath));
  mkdirSync(dirname(config.databasePath), { recursive: true });

  const store = openSierraStore({
    databasePath: config.databasePath,
    ordersPath: config.ordersPath,
    productsPath: config.productsPath,
  });

  const runtime = config.apiKey
    ? {
        mode: "openai" as const,
        model: createOpenAIModelClient({
          apiKey: config.apiKey,
          model: config.model,
          toolSpecVersion: config.toolSpecVersion,
        }),
      }
    : {
        mode: "unconfigured" as const,
        model: createUnavailableModelClient(),
      };

  const chat = createChatApplication({
    store,
    model: runtime.model,
    planningStrategy: config.planningStrategy,
    toolSpecVersion: config.toolSpecVersion,
    now: () => clock.now(),
    monotonicNow: () => clock.monotonicNow(),
    trace,
  });
  const app = Fastify({ logger: input.logger ?? true });
  await registerRoutes(app, { chat, mode: runtime.mode });

  const clientRoot = resolve("dist");
  if (existsSync(clientRoot)) {
    await app.register(fastifyStatic, { root: clientRoot });
  }

  app.addHook("onClose", async () => store.close());
  return { app, config };
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  const { app, config } = await buildServer();
  await app.listen({ port: config.port, host: config.host });
}
