import { z } from "zod";

export const simulatorPresetListSchema = z
	.object({
		presets: z
			.array(
				z
					.object({
						id: z
							.string()
							.min(1)
							.max(80)
							.regex(/^[A-Za-z0-9_.:-]+$/),
						label: z
							.string()
							.trim()
							.min(1)
							.max(80)
							.regex(/^[^\p{Cc}]+$/u),
						contents: z
							.string()
							.min(1)
							.refine(
								(value) => new TextEncoder().encode(value).length <= 128 * 1024,
							),
					})
					.strict(),
			)
			.max(8),
	})
	.strict()
	.refine(
		({ presets }) =>
			new Set(presets.map(({ id }) => id)).size === presets.length,
	);

export type PerTitleSimulatorPreset = z.infer<
	typeof simulatorPresetListSchema
>["presets"][number];
