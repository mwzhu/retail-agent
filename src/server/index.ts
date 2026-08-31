import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { loadConfig } from "./config";
import { openSierraStore } from "./data/store";
import {
  createChatApplication,
  createDemoModelClient,
  createOpenAIModelClient,
  createUnavailableModelClient,
} from "./agent/index";
import { registerRoutes } from "./routes";

export async function buildServer() {
  const config = loadConfig();
  mkdirSync(dirname(config.databasePath), { recursive: true });

  const store = openSierraStore({
    databasePath: config.databasePath,
    ordersPath: config.ordersPath,
    productsPath: config.productsPath,
  });

  const mode = config.demoMode
    ? "demo"
    : config.apiKey
      ? "openai"
      : "unconfigured";

  const model = config.demoMode
    ? createDemoModelClient()
    : config.apiKey
      ? createOpenAIModelClient({ apiKey: config.apiKey, model: config.model })
      : createUnavailableModelClient();

  const chat = createChatApplication({ store, model });
  const app = Fastify({ logger: true });
  await registerRoutes(app, { chat, mode });

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
