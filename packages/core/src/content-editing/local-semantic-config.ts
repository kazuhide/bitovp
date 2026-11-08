import { z } from "zod";

const connectionSchema = z.strictObject({
	url: z.url().refine((value) => {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			url.pathname === "/"
		);
	}),
	token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
	caFile: z
		.string()
		.min(2)
		.max(1024)
		.regex(/^\/[^\r\n\0]+$/),
	profile: z.enum(["amd", "nvidia"]),
	configId: z.uuid(),
});
export type LocalSemanticConfiguration = z.infer<typeof connectionSchema>;

/** Server/operator configuration only; no user request or model output enters here. */
export function readLocalSemanticConfiguration(
	env: Record<string, string | undefined>,
): LocalSemanticConfiguration | undefined {
	if (env.BITOVP_LOCAL_SEMANTIC_ENABLED !== "1") return undefined;
	const result = connectionSchema.safeParse({
		url: env.BITOVP_LOCAL_SEMANTIC_GATEWAY_URL,
		token: env.BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN,
		caFile: env.BITOVP_LOCAL_SEMANTIC_CA_FILE,
		profile: env.BITOVP_LOCAL_SEMANTIC_PROFILE,
		configId: env.BITOVP_LOCAL_SEMANTIC_CONFIG_ID,
	});
	if (!result.success) throw new Error("LOCAL_SEMANTIC_CONFIG_INVALID");
	return result.data;
}
