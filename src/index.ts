#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_BASE_URL, TrafficoxClient } from "./client.js";
import { createServer } from "./server.js";

const apiKey = process.env.TRAFFICOX_API_KEY;
if (!apiKey) {
  console.error("TRAFFICOX_API_KEY is not set. Get your API key in the TrafficOX dashboard.");
  process.exit(1);
}

const api = new TrafficoxClient(apiKey, process.env.TRAFFICOX_API_URL || DEFAULT_BASE_URL);
await createServer(api).connect(new StdioServerTransport());
