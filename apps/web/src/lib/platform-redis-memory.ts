import { z } from "zod";

export const redisMemorySchema = z.strictObject({
	usedBytes: z.int().nonnegative(),
	limitBytes: z.int().positive().nullable(),
});
