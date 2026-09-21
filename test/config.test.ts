import { describe, expect, it } from "vitest";
import { authenticatedHeliusRpcUrl } from "../src/config/index.js";

describe("Helius RPC authentication", () => {
  it("adds the configured API key to a Helius base URL", () => {
    expect(authenticatedHeliusRpcUrl("https://mainnet.helius-rpc.com/", "secret"))
      .toBe("https://mainnet.helius-rpc.com/?api-key=secret");
  });
  it("preserves an explicitly configured API key", () => {
    expect(authenticatedHeliusRpcUrl("https://mainnet.helius-rpc.com/?api-key=explicit", "secret"))
      .toBe("https://mainnet.helius-rpc.com/?api-key=explicit");
  });
  it("does not leak the key to a non-Helius endpoint", () => {
    expect(authenticatedHeliusRpcUrl("https://rpc.example.com/", "secret"))
      .toBe("https://rpc.example.com/");
  });
});
