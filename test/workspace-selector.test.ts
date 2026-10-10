import { test, expect } from "vitest";

test("useTenant hook structure", async () => {
    const { useTenant } = await import("../src/hooks/use-tenant");
    expect(useTenant).toBeDefined();
    expect(typeof useTenant).toBe("function");
});

test("OrganizationSelector exports", async () => {
    const { OrganizationSelector } = await import("../src/components/tenant/organization-selector");
    expect(OrganizationSelector).toBeDefined();
    expect(typeof OrganizationSelector).toBe("function");
});