import { z } from "zod";

const paginationSchema = z.object({
  has_more: z.boolean(),
}).strict();

const commentItemSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
}).strict();
const fieldMetadataItemSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
}).strict();
const transitionItemSchema = z.object({ state_key: z.string().min(1) }).strict();

function pagedListSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    pagination: paginationSchema,
    list: z.array(itemSchema),
  }).strict();
}

function unpagedListSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({ list: z.array(itemSchema) }).strict();
}

export const meegleCommentListSchema = pagedListSchema(commentItemSchema);
export const meegleFieldMetadataListSchema = pagedListSchema(fieldMetadataItemSchema);
export const meegleRoleMetadataListSchema = pagedListSchema(z.never());
export const meegleTransitionListSchema = unpagedListSchema(transitionItemSchema);
export const meegleRequiredFieldListSchema = unpagedListSchema(z.never());
export const meegleNodeFieldListSchema = unpagedListSchema(z.never());

export const meegleCommentMutationSchema = z.object({
  comment_id: z.string().min(1),
}).strict();

export const meegleMutationSchema = z.object({}).strict();
