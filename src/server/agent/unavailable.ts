import { ModelClientError, type ModelClient } from "./types";

export function createUnavailableModelClient(): ModelClient {
  const unavailable = () =>
    new ModelClientError("MODEL_UNAVAILABLE", "No model API key is configured.");

  return {
    selectTools: async () => {
      throw unavailable();
    },
    planIntents: async () => {
      throw unavailable();
    },
    streamFinal: async function* () {
      throw unavailable();
    },
  };
}
