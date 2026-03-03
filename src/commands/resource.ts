// =============================================================================
// acp resource query <url> [--params '<json>'] — Query a resource by URL
// =============================================================================

import axios from "axios";
import * as output from "../lib/output.js";

export async function query(url: string, params?: Record<string, any>): Promise<void> {
  if (!url) {
    output.fatal("Usage: acp resource query <url> [--params '<json>']");
  }

  // Validate URL format
  try {
    new URL(url);
  } catch {
    output.fatal(`Invalid URL: ${url}`);
  }

  try {
    // Make HTTP request to resource URL
    output.log(`\nQuerying resource at: ${url}`);
    if (params && Object.keys(params).length > 0) {
      output.log(`  With params: ${JSON.stringify(params, null, 2)}\n`);
    } else {
      output.log("");
    }

    let response;
    try {
      // Always use GET request, params as query string
      if (params && Object.keys(params).length > 0) {
        // Build query string from params
        const queryString = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
          if (value !== null && value !== undefined) {
            queryString.append(key, String(value));
          }
        }
        const urlWithParams = url.includes("?")
          ? `${url}&${queryString.toString()}`
          : `${url}?${queryString.toString()}`;
        response = await axios.get(urlWithParams);
      } else {
        response = await axios.get(url);
      }
    } catch (httpError: any) {
      if (httpError.response) {
        // Server responded with error status
        const errorMsg = httpError.response.data
          ? JSON.stringify(httpError.response.data, null, 2)
          : httpError.response.statusText;
        output.fatal(
          `Resource query failed: ${httpError.response.status} ${httpError.response.statusText}\n${errorMsg}`
        );
      } else {
        output.fatal(
          `Resource query failed: ${
            httpError instanceof Error ? httpError.message : String(httpError)
          }`
        );
      }
    }

    const responseData = response.data;

    output.output(responseData, (data) => {
      output.heading(`Resource Query Result`);
      output.log(`\n  URL: ${url}`);
      output.log(`\n  Response:`);
      if (typeof data === "string") {
        output.log(`    ${data}`);
      } else {
        output.log(
          `    ${JSON.stringify(data, null, 2)
            .split("\n")
            .map((line, i) => (i === 0 ? line : `    ${line}`))
            .join("\n")}`
        );
      }
      output.log("");
    });
  } catch (e) {
    output.fatal(`Resource query failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
