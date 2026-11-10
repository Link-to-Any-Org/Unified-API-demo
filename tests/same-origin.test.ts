import { describe, expect, it } from "vitest";
import { isSameOriginRequest } from "@/lib/same-origin";

function post(headers: Record<string, string>) {
  return new Request("http://app.example.com/api/connect/credentials", { method: "POST", headers });
}

describe("isSameOriginRequest", () => {
  it("trusts the browser's Sec-Fetch-Site when present", () => {
    expect(isSameOriginRequest(post({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOriginRequest(post({ "sec-fetch-site": "none" }))).toBe(true);
    expect(isSameOriginRequest(post({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOriginRequest(post({ "sec-fetch-site": "same-site" }))).toBe(false);
  });

  it("falls back to comparing Origin with the request host", () => {
    expect(isSameOriginRequest(post({ origin: "https://app.example.com", host: "app.example.com" }))).toBe(true);
    expect(isSameOriginRequest(post({ origin: "https://evil.example.net", host: "app.example.com" }))).toBe(false);
  });

  it("uses the forwarded host behind a tunnel or proxy", () => {
    expect(
      isSameOriginRequest(
        post({ origin: "https://demo.ngrok-free.dev", host: "localhost:3000", "x-forwarded-host": "demo.ngrok-free.dev" })
      )
    ).toBe(true);
  });

  it("rejects a request that identifies no origin at all", () => {
    expect(isSameOriginRequest(post({}))).toBe(false);
    expect(isSameOriginRequest(post({ origin: "not a url", host: "app.example.com" }))).toBe(false);
  });
});
