import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const seed = readFileSync(join(process.cwd(), "prisma/seed.ts"), "utf8");

describe("seed safety", () => {
  it("does not destructively clean unrelated data", () => {
    expect(seed).not.toMatch(/\.deleteMany\s*\(/);
    expect(seed).not.toMatch(/\.delete\s*\(/);
  });

  it("requires an explicit password or isolated demo mode before using demo credentials", () => {
    expect(seed).toContain("SEED_ADMIN_PASSWORD");
    expect(seed).toContain("WBA_ALLOW_DEMO_SEED");
    expect(seed).toContain('process.env.NODE_ENV === "test"');
    expect(seed).toContain("throw new Error");
  });
});
