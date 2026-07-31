export type CustomFieldType = "select" | "textarea" | "user_chooser";

export interface FieldDefinition {
  name: string;
  type: CustomFieldType;
  options?: readonly string[];
  memo: string;
}

export interface CustomField {
  name: string;
  type: string;
  options: string[];
  field: string;
  enabled: boolean;
}

export interface FieldAdmin {
  listCustomFields(): Promise<CustomField[]>;
  createCustomField(field: FieldDefinition): Promise<CustomField>;
}

export const FLOWRIVET_FIELDS: readonly FieldDefinition[] = [
  {
    name: "需求来源类型",
    type: "select",
    options: ["用户VOC", "产品规划", "体验优化", "技术", "质量", "安全合规", "战略", "探索"],
    memo: "需求来源及证据分类",
  },
  { name: "证据链接", type: "textarea", memo: "VOC、数据、调研或相关材料链接" },
  { name: "目标用户", type: "textarea", memo: "受影响的目标用户或角色" },
  { name: "使用场景", type: "textarea", memo: "用户在何种场景下使用" },
  { name: "当前问题", type: "textarea", memo: "当前问题、痛点及影响" },
  { name: "需求目标", type: "textarea", memo: "本需求期望达成的业务或用户目标" },
  { name: "成功指标", type: "textarea", memo: "可验证、可度量的成功标准" },
  { name: "范围", type: "textarea", memo: "本次需求包含的范围" },
  { name: "不做范围", type: "textarea", memo: "本次明确不包含的范围" },
  { name: "产品负责人", type: "user_chooser", memo: "产品侧闭环负责人" },
  { name: "研发负责人", type: "user_chooser", memo: "研发侧闭环负责人" },
  { name: "测试负责人", type: "user_chooser", memo: "测试侧闭环负责人" },
  { name: "阻断问题", type: "textarea", memo: "阻止进入下一状态的问题及责任人" },
  {
    name: "门禁结果",
    type: "select",
    options: ["未检查", "通过", "阻断", "有条件通过"],
    memo: "当前阶段准入或准出检查结果",
  },
] as const;

export interface FieldInitializationResult {
  planned: string[];
  created: string[];
  skipped: string[];
  mapping: Record<string, string>;
}

export async function initializeFields(
  admin: FieldAdmin,
  options: { dryRun: boolean },
): Promise<FieldInitializationResult> {
  const existing = await admin.listCustomFields();
  const byName = new Map(existing.map((field) => [field.name, field]));

  for (const definition of FLOWRIVET_FIELDS) {
    const current = byName.get(definition.name);
    if (!current) continue;
    if (current.type !== definition.type) {
      throw new Error(
        `${definition.name} type mismatch: expected ${definition.type}, received ${current.type}`,
      );
    }
    if (
      definition.options &&
      JSON.stringify(current.options) !== JSON.stringify(definition.options)
    ) {
      throw new Error(`${definition.name} options mismatch`);
    }
  }

  const result: FieldInitializationResult = {
    planned: [],
    created: [],
    skipped: [],
    mapping: {},
  };

  for (const definition of FLOWRIVET_FIELDS) {
    const current = byName.get(definition.name);
    if (current) {
      result.skipped.push(definition.name);
      result.mapping[definition.name] = current.field;
      continue;
    }

    result.planned.push(definition.name);
    if (options.dryRun) continue;

    const created = await admin.createCustomField(definition);
    result.created.push(definition.name);
    result.mapping[definition.name] = created.field;
  }

  return result;
}
