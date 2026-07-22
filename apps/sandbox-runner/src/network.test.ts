import { describe, expect, it } from "vitest";
import { isBlockedAddress } from "./network.js";

describe("network policy", () => {
  it.each(["127.0.0.1", "10.0.0.1", "192.168.1.2", "169.254.169.254", "::1", "fc00::1"])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });
  it("allows public addresses", () => expect(isBlockedAddress("1.1.1.1")).toBe(false));
});
