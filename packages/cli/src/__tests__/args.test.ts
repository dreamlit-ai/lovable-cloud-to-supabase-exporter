import { describe, expect, it } from "vitest";
import { getStringFlag, parseArgs } from "../utils";

describe("parseArgs", () => {
  it("parses positionals and flags", () => {
    const parsed = parseArgs(["db", "clone", "--base-url", "https://x", "--json"]);
    expect(parsed.positionals).toEqual(["db", "clone"]);
    expect(getStringFlag(parsed.flags, "base-url")).toBe("https://x");
    expect(parsed.flags.json).toBe(true);
  });
});
