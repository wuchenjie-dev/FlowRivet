import { describe, expect, it } from "vitest";

import {
  FLOWRIVET_FIELDS,
  initializeFields,
  type CustomField,
  type FieldDefinition,
  type FieldAdmin,
} from "../src/tapd/fields.js";

class MemoryFieldAdmin implements FieldAdmin {
  readonly created: FieldDefinition[] = [];

  constructor(private readonly fields: CustomField[]) {}

  async listCustomFields(): Promise<CustomField[]> {
    return this.fields;
  }

  async createCustomField(field: FieldDefinition): Promise<CustomField> {
    this.created.push(field);
    const created = {
      name: field.name,
      type: field.type,
      options: field.options ? [...field.options] : [],
      field: `custom_field_${this.fields.length + 1}`,
      enabled: true,
    };
    this.fields.push(created);
    return created;
  }
}

describe("initializeFields", () => {
  it("plans all missing fields without writing in dry-run", async () => {
    const admin = new MemoryFieldAdmin([]);

    const result = await initializeFields(admin, { dryRun: true });

    expect(result.created).toEqual([]);
    expect(result.planned).toHaveLength(14);
    expect(admin.created).toEqual([]);
  });

  it("creates missing fields when writes are enabled", async () => {
    const admin = new MemoryFieldAdmin([]);

    const result = await initializeFields(admin, { dryRun: false });

    expect(result.created).toHaveLength(14);
    expect(result.mapping["门禁结果"]).toBe("custom_field_14");
  });

  it("is idempotent when all fields already exist", async () => {
    const existing = FLOWRIVET_FIELDS.map((field, index) => ({
      name: field.name,
      type: field.type,
      options: field.options ? [...field.options] : [],
      field: `custom_field_${index + 1}`,
      enabled: true,
    }));
    const admin = new MemoryFieldAdmin(existing);

    const result = await initializeFields(admin, { dryRun: false });

    expect(result.skipped).toHaveLength(14);
    expect(admin.created).toEqual([]);
  });

  it("blocks initialization when an existing field has the wrong type", async () => {
    const admin = new MemoryFieldAdmin([
      {
        name: "门禁结果",
        type: "textarea",
        options: [],
        field: "custom_field_one",
        enabled: true,
      },
    ]);

    await expect(initializeFields(admin, { dryRun: false })).rejects.toThrow(
      /门禁结果.*type mismatch/,
    );
    expect(admin.created).toEqual([]);
  });

  it("blocks initialization when select options drift", async () => {
    const admin = new MemoryFieldAdmin([
      {
        name: "门禁结果",
        type: "select",
        options: ["通过", "阻断"],
        field: "custom_field_one",
        enabled: true,
      },
    ]);

    await expect(initializeFields(admin, { dryRun: false })).rejects.toThrow(
      /门禁结果.*options mismatch/,
    );
    expect(admin.created).toEqual([]);
  });
});
