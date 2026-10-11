import { describe, expect, it } from "vitest";
import { isStatusAsyncEnabled, WHATSAPP_STATUS_ASYNC_ENABLED } from "@/lib/whatsapp/status/config";

describe("status async config", () => {
  it("defaults to false", () => {
    expect(isStatusAsyncEnabled({})).toBe(false);
  });

  it("enables when env flag is true", () => {
    expect(isStatusAsyncEnabled({ [WHATSAPP_STATUS_ASYNC_ENABLED]: "true" })).toBe(true);
    expect(isStatusAsyncEnabled({ [WHATSAPP_STATUS_ASYNC_ENABLED]: "TRUE" })).toBe(true);
    expect(isStatusAsyncEnabled({ [WHATSAPP_STATUS_ASYNC_ENABLED]: "false" })).toBe(false);
  });
});
