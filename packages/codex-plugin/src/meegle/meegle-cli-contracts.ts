import { z } from "zod";

const cliOpaqueTokenSchema = z.string().min(1).max(512)
  .regex(/^[A-Za-z0-9._~+-]+$/u);

export const meegleAuthStatusSchema = z.object({
  authenticated: z.boolean(),
  host: z.string().min(1),
  expires_in_minutes: z.number().nonnegative().optional(),
  reason: z.string().min(1).optional(),
}).strict();

export const meegleUserSchema = z.object({
  avatar_url: z.url().optional(),
  email: z.email().optional(),
  name_cn: z.string().min(1),
  name_en: z.string().min(1),
  user_key: z.string().min(1),
}).strict();

const meegleWorkItemSchema = z.object({
  finish_time: z.object({
    finish_time: z.string().min(1),
  }).strict().nullable().optional(),
  node_info: z.object({
    node_name: z.string().min(1),
    node_state_key: z.string().min(1),
  }).strict(),
  project_key: z.string().min(1),
  project_name: z.string().min(1),
  schedule: z.unknown().nullable().optional(),
  state_info: z.object({
    end_state_key_name: z.string(),
    start_state_key_name: z.string(),
  }).strict(),
  work_item_info: z.object({
    work_item_id: z.union([z.number().int().nonnegative(), z.string().min(1)]),
    work_item_name: z.string().min(1),
    work_item_type_key: z.string().min(1),
  }).strict(),
}).strict();

export const meegleMyWorkPageSchema = z.object({
  list: z.array(meegleWorkItemSchema).nullable(),
  total: z.number().int().nonnegative(),
}).strict();

export const meegleProjectSearchSchema = z.object({
  pagination: z.object({
    has_more: z.boolean(),
    page_num: z.number().int().nonnegative(),
    page_size: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict(),
  projects: z.array(z.object({
    name: z.string().min(1),
    project_key: z.string().min(1),
    simple_name: z.string().min(1),
  }).strict()),
}).strict();

export const meegleProjectSchema = meegleProjectSearchSchema.shape.projects.element;

export const meegleWorkItemTypeSchema = z.object({
  api_name: z.string().min(1).max(512),
  enable_model_resource_lib: z.boolean(),
  is_disable: z.number().int(),
  name: z.string().min(1).max(512),
  type_key: z.string().min(1).max(512),
}).strict();

export const meegleWorkItemTypeListSchema = z.object({
  list: z.array(meegleWorkItemTypeSchema),
}).strict();

const meegleCreatedFieldSchema = z.discriminatedUnion("key", [
  z.object({
    key: z.literal("work_item_id"),
    name: z.string().min(1).max(512),
    value: z.object({ long_value: z.number().int().nonnegative() }).strict(),
    value_type: z.literal("long_value"),
  }).strict(),
  z.object({
    key: z.literal("name"),
    name: z.string().min(1).max(512),
    value: z.object({ string_value: z.string().min(1).max(16_384) }).strict(),
    value_type: z.literal("string_value"),
  }).strict(),
  z.object({
    key: z.literal("work_item_status"),
    name: z.string().min(1).max(512),
    value: z.object({
      key_label_value_list: z.array(z.object({
        key: z.string().min(1).max(512),
        label: z.string().min(1).max(512),
      }).strict()).length(1),
    }).strict(),
    value_type: z.literal("key_label_value_list"),
  }).strict(),
  z.object({
    key: z.literal("finish_time"),
    name: z.string().min(1).max(512),
    value: z.object({ string_value: z.string().min(1).max(512) }).strict().nullable(),
    value_type: z.literal("string_value"),
  }).strict(),
]);

const meegleCreatedRowSchema = z.object({
  moql_field_list: z.array(meegleCreatedFieldSchema).length(4),
}).strict().superRefine((row, context) => {
  const keys = new Set(row.moql_field_list.map((field) => field.key));
  if (keys.size !== 4) context.addIssue({ code: "custom", message: "created fields must be unique" });
});

const meegleCreatedQueryCommon = {
  extra_info: z.null(),
  search_status_info: z.null(),
  session_id: cliOpaqueTokenSchema,
};

const meegleCreatedWorkItemNonEmptySchema = z.object({
  ...meegleCreatedQueryCommon,
  data: z.object({
    "1": z.array(meegleCreatedRowSchema).min(1).max(50),
  }).strict(),
  list: z.tuple([z.object({
    count: z.number().int().positive(),
    group_infos: z.tuple([z.object({
      group_id: z.literal("1"),
      group_name: z.string().min(1).max(512),
    }).strict()]),
  }).strict()]),
}).strict();

const meegleCreatedWorkItemEmptySchema = z.object({
  ...meegleCreatedQueryCommon,
  data: z.object({}).strict(),
  list: z.null(),
}).strict();

export const meegleCreatedWorkItemQuerySchema = z.union([
  meegleCreatedWorkItemNonEmptySchema,
  meegleCreatedWorkItemEmptySchema,
]);

const meegleDetailUserSchema = z.object({
  email: z.string(),
  key: z.string().min(1),
  name: z.string().min(1),
}).strip();

export const meegleWorkItemDetailSchema = z.object({
  pagination: z.object({
    has_more: z.boolean(),
    page_size: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    next_page_token: z.string().min(1).optional(),
  }).strip(),
  work_item_attribute: z.object({
    create_by: meegleDetailUserSchema,
    create_time: z.string().min(1),
    owned_project: z.object({
      key: z.string().min(1),
      name: z.string().min(1),
      simple_name: z.string().min(1),
    }).strip(),
    template: z.object({
      id: z.union([z.number().int().nonnegative(), z.string().min(1)]),
      name: z.string().min(1),
    }).strip(),
    update_time: z.string().min(1),
    updated_by: meegleDetailUserSchema,
    work_item_id: z.union([z.number().int().nonnegative(), z.string().min(1)]),
    work_item_mod: z.string().min(1),
    work_item_name: z.string().min(1),
    work_item_status: z.object({ key: z.string().min(1), name: z.string().min(1) }).strip(),
    work_item_type: z.object({ key: z.string().min(1), name: z.string().min(1) }).strip(),
  }).strip(),
  work_item_fields: z.array(z.object({
    key: z.string().min(1),
    name: z.string().min(1),
    value: z.unknown().transform((value) => value === null
      ? null
      : typeof value === "string"
        ? value
        : JSON.stringify(value)),
  }).strip()),
}).strip();

export const meegleDeviceInitSchema = z.object({
  client_id: cliOpaqueTokenSchema,
  device_code: cliOpaqueTokenSchema,
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
  user_code: z.string().min(1),
  verification_uri: z.url().refine((value) => value.startsWith("https://")),
  verification_uri_complete: z.url().refine((value) => value.startsWith("https://")),
}).strict();

export const meegleDevicePollSchema = z.union([
  z.object({ error: z.enum(["authorization_pending", "expired_token"]) }).strict(),
  z.object({
    status: z.enum(["ok", "authorization_pending"]),
    message: z.string().optional(),
  }).strict(),
]);

export type MeegleAuthStatus = z.infer<typeof meegleAuthStatusSchema>;
export type MeegleUser = z.infer<typeof meegleUserSchema>;
export type MeegleMyWorkPage = z.infer<typeof meegleMyWorkPageSchema>;
export type MeegleProject = z.infer<typeof meegleProjectSchema>;
export type MeegleWorkItemType = z.infer<typeof meegleWorkItemTypeSchema>;
export type MeegleCreatedWorkItemQuery = z.infer<typeof meegleCreatedWorkItemQuerySchema>;
export type MeegleWorkItemDetail = z.infer<typeof meegleWorkItemDetailSchema>;
