import { describe, expect, it } from "vitest";
import { authConfig } from "@/auth.config";

const authorized = authConfig.callbacks?.authorized;

function request(pathname: string, method = "GET") {
  return {
    method,
    nextUrl: new URL(`https://example.test${pathname}`),
  } as Parameters<NonNullable<typeof authorized>>[0]["request"];
}

describe("auth boundary", () => {
  it("returns 401 JSON for anonymous tenant contact reads", async () => {
    const response = await authorized?.({
      auth: null,
      request: request("/api/tenants/tenant-1/contacts/contact-1"),
    });

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(401);
    expect((response as Response).headers.get("content-type")).toContain("application/json");
    expect(await (response as Response).json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 JSON for anonymous tenant conversation reads", async () => {
    const response = await authorized?.({
      auth: null,
      request: request("/api/tenants/tenant-1/conversations/conversation-1"),
    });

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(401);
    expect((response as Response).headers.get("content-type")).toContain("application/json");
  });

  it("keeps browser pages protected by login redirect behavior", async () => {
    const response = await authorized?.({ auth: null, request: request("/inbox") });

    expect(response).toBe(false);
  });

  it("does not exempt similar-looking tenant API paths", async () => {
    const paths = [
      "/api/tenants/tenant-1/contacts/contact-1/messages",
      "/api/tenants/tenant-1/users/user-1",
    ];

    for (const pathname of paths) {
      const response = await authorized?.({ auth: null, request: request(pathname) });
      expect(response).toBe(false);
    }
  });

  it("returns 401 JSON for anonymous tenant message history", async () => {
    const response = await authorized?.({
      auth: null,
      request: request("/api/tenants/tenant-1/conversations/conversation-1/messages"),
    });

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(401);
    expect((response as Response).headers.get("content-type")).toContain("application/json");
    expect(await (response as Response).json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 JSON for anonymous tenant contact list", async () => {
    const response = await authorized?.({
      auth: null,
      request: request("/api/tenants/tenant-1/contacts"),
    });

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(401);
    expect((response as Response).headers.get("content-type")).toContain("application/json");
    expect(await (response as Response).json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 JSON for anonymous tenant conversation list", async () => {
    const response = await authorized?.({
      auth: null,
      request: request("/api/tenants/tenant-1/conversations"),
    });

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(401);
    expect((response as Response).headers.get("content-type")).toContain("application/json");
  });

  it("does not convert non-GET tenant requests to JSON 401", async () => {
    const response = await authorized?.({
      auth: null,
      request: request("/api/tenants/tenant-1/contacts/contact-1", "POST"),
    });

    expect(response).toBe(false);
  });
});
