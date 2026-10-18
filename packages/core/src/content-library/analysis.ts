import { z } from "zod";

export const MAX_SCENE_ANALYSIS_BYTES = 8 * 1024 * 1024;
const seconds = z.number().finite().nonnegative();
const text = (max = 16_000) =>
	z
		.string()
		.max(max)
		.nullish()
		.transform((v) => v ?? "");
const list = <T extends z.ZodType>(item: T, max = 200) =>
	z
		.array(item.nullable())
		.max(max)
		.nullish()
		.transform((v) =>
			(v ?? []).filter((entry): entry is z.output<T> => entry !== null),
		);
const keywords = list(z.string().max(512));
const optional = <T extends z.ZodType>(schema: T) =>
	schema.nullish().transform((v) => v ?? undefined);

const subject = z.object({
	classification: z.string().min(1).max(512),
	description: z.string().max(16_000),
	// Provider observations use seconds relative to the enclosing shot.
	appearanceTimeInSeconds: seconds,
	centerX: z.number().finite().min(0).max(100),
	centerY: z.number().finite().min(0).max(100),
});
const shotFields = z.object({
	startInSeconds: seconds,
	endInSeconds: seconds,
	detailedDescription: text(),
	keywords,
	mainSubjects: list(subject),
	shotAdvisories: optional(
		z.object({
			status: z.string().min(1).max(128),
			advisories: list(
				z.object({
					category: z.string().min(1).max(128),
					confidence: z.string().min(1).max(128),
					reason: text(),
				}),
			),
		}),
	),
});
const shot = shotFields.superRefine((value, ctx) => {
	if (value.endInSeconds <= value.startInSeconds) {
		ctx.addIssue({
			code: "custom",
			message: "Shot interval must be positive",
		});
	}
	value.mainSubjects.forEach((item, index) => {
		if (
			item.appearanceTimeInSeconds >
			value.endInSeconds - value.startInSeconds
		) {
			ctx.addIssue({
				code: "custom",
				path: ["mainSubjects", index],
				message: "Subject relative appearance time exceeds shot duration",
			});
		}
	});
});
const character = z.object({
	name: text(512),
	playedBy: text(512),
	description: text(),
	appearance: optional(z.string().max(16_000)),
	characterAppearance: optional(
		z.object({
			summary: text(),
			gender: text(512),
			hairColor: text(512),
			hairStyle: text(512),
			hairFullness: text(512),
			facialHair: text(512),
			physicalBuild: text(512),
			distinguishingFeatures: text(),
			clothing: text(),
		}),
	),
});
const sceneFields = z.object({
	id: z.string().uuid(),
	startInSeconds: seconds,
	endInSeconds: seconds,
	type: text(128),
	title: text(1_024),
	summary: text(),
	verboseSummary: text(64_000),
	keywords,
	sensitiveTopics: keywords,
	content: optional(
		z.object({
			characters: list(character),
			objects: list(z.object({ category: text(512), description: text() })),
			dynamics: optional(z.object({ tension: text(512), pacing: text(512) })),
			settings: optional(
				list(
					z.object({
						location: optional(
							z.object({ name: text(512), description: text() }),
						),
						timeOfDay: text(512),
						atmosphere: optional(
							z.object({
								mood: text(512),
								lighting: text(512),
								weather: text(512),
							}),
						),
					}),
				),
			),
		}),
	),
	iab: optional(
		z.object({
			contentVersion: text(128),
			adProductVersion: text(128),
			contentTaxonomies: keywords,
			adOpportunityTaxonomies: keywords,
			sensitiveTopicTaxonomies: keywords,
		}),
	),
	adOpportunityInformation: optional(
		z.object({
			reason: text(),
			score: optional(z.number().finite().min(0).max(1)),
		}),
	),
	shots: list(shot, 5_000),
});
const scene = sceneFields.superRefine((value, ctx) => {
	if (value.endInSeconds <= value.startInSeconds) {
		ctx.addIssue({
			code: "custom",
			message: "Scene interval must be positive",
		});
	}
	value.shots.forEach((item, index) => {
		if (
			item.startInSeconds >= value.endInSeconds ||
			item.endInSeconds <= value.startInSeconds
		) {
			ctx.addIssue({
				code: "custom",
				path: ["shots", index],
				message: "Shot must overlap its scene",
			});
		}
	});
});
export const sceneAnalysisDocumentSchema = z
	.object({
		providerVersion: z.string().trim().min(1).max(128),
		omittedSubjectCount: z.number().int().nonnegative().optional(),
		duration: z.number().finite().positive(),
		title: text(1_024),
		description: text(64_000),
		keywords,
		sensitiveTopics: keywords,
		iabSensitiveTopicTaxonomies: keywords,
		credits: optional(
			z.object({
				persons: list(
					z.object({ name: text(512), role: text(512), department: text(512) }),
					2_000,
				),
				songs: list(z.object({ name: text(512), artist: text(512) }), 1_000),
				copyright: text(),
			}),
		),
		scenes: list(scene, 5_000),
	})
	.superRefine((value, ctx) => {
		const ids = new Set<string>();
		value.scenes.forEach((item, index) => {
			if (ids.has(item.id.toLowerCase())) {
				ctx.addIssue({
					code: "custom",
					path: ["scenes", index, "id"],
					message: "Scene IDs must be unique",
				});
			}
			ids.add(item.id.toLowerCase());
			// Provider shots can cross scene boundaries; keep their original timing.
			// Asset bounds still apply independently of the owning scene interval.
			item.shots.forEach((shot, shotIndex) => {
				if (shot.endInSeconds > value.duration) {
					ctx.addIssue({
						code: "custom",
						path: ["scenes", index, "shots", shotIndex],
						message: "Shot exceeds document duration",
					});
				}
			});
			if (item.endInSeconds > value.duration) {
				ctx.addIssue({
					code: "custom",
					path: ["scenes", index],
					message: "Scene exceeds document duration",
				});
			}
		});
	});

const document = z
	.object({
		...sceneAnalysisDocumentSchema.shape,
		scenes: list(sceneFields.extend({ shots: list(shotFields, 5_000) }), 5_000),
		providerVersion: z.unknown().optional(),
		metadata: z.object({ version: z.string().trim().min(1).max(128) }),
	})
	.transform(
		({
			metadata,
			providerVersion: _ignored,
			omittedSubjectCount: _untrusted,
			...value
		}) => {
			let omittedSubjectCount = 0;
			for (const scene of value.scenes) {
				for (const shot of scene.shots) {
					shot.mainSubjects = shot.mainSubjects.filter((subject) => {
						const withinShot =
							subject.appearanceTimeInSeconds <=
							shot.endInSeconds - shot.startInSeconds;
						if (!withinShot) omittedSubjectCount++;
						return withinShot;
					});
				}
			}
			return {
				...value,
				providerVersion: metadata.version,
				...(omittedSubjectCount ? { omittedSubjectCount } : {}),
			};
		},
	);

export type SceneAnalysisDocument = z.output<
	typeof sceneAnalysisDocumentSchema
>;

/** Accept future provider versions while projecting only validated, bounded fields. */
export function normalizeSceneAnalysis(raw: unknown): SceneAnalysisDocument {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(raw);
	} catch {
		throw new Error("Scene analysis must be serializable JSON");
	}
	if (
		serialized === undefined ||
		new TextEncoder().encode(serialized).byteLength > MAX_SCENE_ANALYSIS_BYTES
	) {
		throw new Error(
			"Scene analysis exceeds the 8 MiB JSON limit or is not JSON",
		);
	}
	return sceneAnalysisDocumentSchema.parse(document.parse(raw));
}
