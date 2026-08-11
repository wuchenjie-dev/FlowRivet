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
