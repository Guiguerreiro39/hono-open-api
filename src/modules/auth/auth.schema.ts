import { z } from "@hono/zod-openapi";

export const MeSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  role: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const PatchMeSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  image: z.string().trim().min(1).max(2048).nullable().optional(),
}).refine(
  data => data.name !== undefined || data.image !== undefined,
  { message: "At least one field must be provided" },
);

export type MeDto = z.infer<typeof MeSchema>;
export type PatchMeDto = z.infer<typeof PatchMeSchema>;
