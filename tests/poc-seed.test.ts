import { describe, expect, it } from "vitest";

import {
  POC_REQUIREMENTS,
  seedPocRequirements,
  type PocStoryAdmin,
  type PocStoryInput,
} from "../src/poc/seed.js";
import { FLOWRIVET_FIELDS, type CustomField } from "../src/tapd/fields.js";

class MemoryPocAdmin implements PocStoryAdmin {
  readonly created: PocStoryInput[] = [];

  constructor(private readonly existingTitles: string[] = []) {}

  async listCustomFields(): Promise<CustomField[]> {
    return FLOWRIVET_FIELDS.map((field, index) => ({
      name: field.name,
      type: field.type,
      options: field.options ? [...field.options] : [],
      field: index < 8 ? `custom_field_${["one", "two", "three", "four", "five", "six", "seven", "eight"][index]}` : `custom_field_${index + 1}`,
      enabled: true,
    }));
  }

  async findStoryByExactTitle(title: string): Promise<{ id: string } | undefined> {
    return this.existingTitles.includes(title) ? { id: "existing-id" } : undefined;
  }

  async createStory(input: PocStoryInput): Promise<{ id: string }> {
    this.created.push(input);
    return { id: `created-${this.created.length}` };
  }
}

describe("seedPocRequirements", () => {
  it("previews three requirements without writing", async () => {
    const admin = new MemoryPocAdmin();

    const result = await seedPocRequirements(admin, { dryRun: true, owner: "wuchenjie" });

    expect(result.planned).toHaveLength(3);
    expect(admin.created).toEqual([]);
  });

  it("creates three marked requirements with mapped custom fields", async () => {
    const admin = new MemoryPocAdmin();

    const result = await seedPocRequirements(admin, { dryRun: false, owner: "wuchenjie" });

    expect(result.created).toHaveLength(3);
    expect(admin.created[0]?.name).toMatch(/^\[FLOWRIVET_POC\]/);
    expect(admin.created[0]?.fields.custom_field_10).toBe("wuchenjie");
    expect(admin.created[2]?.fields.custom_field_seven).toBe("");
  });

  it("skips exact existing PoC titles", async () => {
    const admin = new MemoryPocAdmin(POC_REQUIREMENTS.map((item) => item.title));

    const result = await seedPocRequirements(admin, { dryRun: false, owner: "wuchenjie" });

    expect(result.skipped).toHaveLength(3);
    expect(admin.created).toEqual([]);
  });
});
