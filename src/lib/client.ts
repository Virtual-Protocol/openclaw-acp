// =============================================================================
// Axios HTTP client for the ACP API.
// Retries on 429 (rate limit) and 5xx with exponential backoff to avoid abuse.
// =============================================================================

import axios, { type InternalAxiosRequestConfig } from "axios";
import dotenv from "dotenv";
import { loadApiKey } from "./config.js";

dotenv.config();

// Ensure API key is loaded from config
loadApiKey();

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const client = axios.create({
  baseURL: process.env.ACP_API_URL || "https://claw-api.virtuals.io",
  headers: {
    "x-api-key": process.env.LITE_AGENT_API_KEY,
  },
});

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config as InternalAxiosRequestConfig & { _retryCount?: number };
    const status = error.response?.status;
    const shouldRetry =
      (status === 429 || (status != null && status >= 500)) &&
      config &&
      (config._retryCount ?? 0) < MAX_RETRIES;

    if (shouldRetry) {
      config._retryCount = (config._retryCount ?? 0) + 1;
      const delay = RETRY_DELAY_MS * Math.pow(2, config._retryCount - 1);
      await sleep(delay);
      return client.request(config);
    }

    if (error.response) {
      throw new Error(JSON.stringify(error.response.data));
    }
    throw error;
  }
);

export default client;
