import type { ExpectedManifest } from "@bitovp/core";
import type { Check, ParsedDash, ParsedHls } from "./engine";
import {
	bindHlsVideoReferences,
	checkHlsReferenceObjects,
	storageObjectUrl,
} from "./hls-video-reference-binding";

type Media = NonNullable<ExpectedManifest["hlsAdditionalMedia"]>[number];
type ExternalSubtitle = { url: string; language: string };
type AudioGroups = NonNullable<ExpectedManifest["hlsAudioGroups"]>;
const check = (id: string, condition: boolean, detail: string): Check => ({
	id,
	area: "manifest",
	verdict: condition ? "PASS" : "FAIL",
	detail,
});
const unverified = (id: string): Check => ({
	id,
	area: "manifest",
	verdict: "SKIP",
	detail:
		"External subtitle bytes were not fetched; URL binding does not prove remote availability or WebVTT validity",
});

/** Only the highest-priority configured group still present in the master may be selected. */
export function selectedHlsAudioGroups(
	config: AudioGroups,
	parsed: ParsedHls,
): { groups: string[]; dropStream: boolean } {
	const available = new Set(
		parsed.media
			.filter((row) => row.type === "AUDIO")
			.map((row) => row.groupId),
	);
	const matching = config.groups.filter((group) => available.has(group.name));
	const priority = Math.max(...matching.map((group) => group.priority));
	const first = matching.find((group) => group.priority === priority);
	return {
		groups: first ? [first.name] : [],
		dropStream: matching.length === 0 && config.droppingMode === "STREAM",
	};
}

export function hlsAudioGroupChecks(
	id: string,
	config: AudioGroups,
	parsed: ParsedHls,
): Check[] {
	const selection = selectedHlsAudioGroups(config, parsed);
	return [
		check(
			`${id}:audio-group-selection`,
			selection.dropStream
				? parsed.variants.length === 0
				: parsed.variants.every((row) =>
						selection.groups.length
							? row.audio !== undefined && selection.groups.includes(row.audio)
							: row.audio === undefined,
					),
			"Variants must use a highest-priority available configured audio group; when none survives, the configured stream/audio dropping rule applies",
		),
	];
}

export function hlsMediaReferenceChecks(
	id: string,
	expected: readonly Media[],
	parsed: ParsedHls,
): Check[] {
	const available = [...parsed.media];
	return expected.map((media, index) => {
		const found = available.findIndex(
			(row) =>
				row.type === media.type &&
				row.groupId === media.groupId &&
				row.name === media.name &&
				row.uri === media.uri &&
				(media.language === undefined || row.language === media.language) &&
				(media.instreamId === undefined || row.instreamId === media.instreamId),
		);
		if (found >= 0) available.splice(found, 1);
		return check(
			`${id}:additional-media:${index}:reference`,
			found >= 0,
			"Configured HLS media must retain its type, group, name, URI, language, and caption identity",
		);
	});
}

export function externalVttReferenceChecks(
	id: string,
	url: string,
	parsed: ParsedHls,
): Check[] {
	return [
		check(
			`${id}:reference`,
			(parsed.segmentUris?.length ?? 0) > 0 &&
				parsed.segmentUris?.every((uri) => uri === url) === true &&
				parsed.mapUri === undefined,
			"The generated subtitle playlist must reference only its configured external WebVTT URL",
		),
		unverified(`${id}:content`),
	];
}

export async function collectHlsReferenceChecks(
	deps: {
		readText(outputKey: string, key: string): Promise<string>;
		parseHls(text: string): Promise<ParsedHls>;
		listAll(
			outputKey: string,
			prefix: string,
		): Promise<{ key: string; size?: number }[]>;
	},
	id: string,
	manifest: {
		outputKey: string;
		dir: { prefix: string };
		hlsAdditionalMedia?: readonly Media[];
		hlsAudioGroups?: AudioGroups;
	},
	parsed: ParsedHls,
): Promise<Check[]> {
	const expected = manifest.hlsAdditionalMedia ?? [];
	const checks = hlsMediaReferenceChecks(id, expected, parsed);
	if (manifest.hlsAudioGroups)
		checks.push(...hlsAudioGroupChecks(id, manifest.hlsAudioGroups, parsed));
	let index = 0;
	for (const [mediaIndex, media] of expected.entries()) {
		if (!media.uri) continue;
		const sid = media.vttUrl
			? `${id}:external-subtitle:${index++}`
			: `${id}:additional-media:${mediaIndex}:playlist`;
		let child: ParsedHls;
		try {
			child = await deps.parseHls(
				await deps.readText(
					manifest.outputKey,
					`${manifest.dir.prefix}${media.uri}`,
				),
			);
		} catch {
			if (media.vttUrl)
				checks.push(
					check(
						`${sid}:reference`,
						false,
						"The configured external subtitle playlist was not readable or parseable",
					),
					unverified(`${sid}:content`),
				);
			else
				checks.push(
					check(
						sid,
						false,
						"The configured video media playlist was not readable or parseable",
					),
				);
			continue;
		}
		if (media.vttUrl) {
			checks.push(...externalVttReferenceChecks(sid, media.vttUrl, child));
			continue;
		}
		checks.push(
			check(
				sid,
				(child.segmentUris?.length ?? 0) > 0 &&
					(!media.requiresInit || child.mapUri !== undefined),
				"Configured HLS video media must publish a playable child with its required initialization reference",
			),
		);
		const root = new URL("https://objects.invalid/");
		const binding = bindHlsVideoReferences(`${sid}:binding`, media, child, {
			outputKey: manifest.outputKey,
			playlist: storageObjectUrl(root, `${manifest.dir.prefix}${media.uri}`),
			storageRoot: root,
		});
		checks.push(binding.check);
		if (binding.check.verdict === "PASS" && media.resource) {
			try {
				checks.push(
					checkHlsReferenceObjects(
						`${sid}:objects`,
						binding.objects,
						await deps.listAll(manifest.outputKey, media.resource.directory),
					),
				);
			} catch {
				checks.push(
					check(
						`${sid}:objects`,
						false,
						"The configured VIDEO writer's object listing could not be read",
					),
				);
			}
		} else
			checks.push({
				id: `${sid}:objects`,
				area: "manifest",
				verdict: "SKIP",
				detail:
					"Object bytes cannot certify a VIDEO child whose writer binding was not proven",
			});
		if (
			media.startSegmentNumber !== undefined ||
			media.endSegmentNumber !== undefined
		)
			checks.push({
				id: `${sid}:selected-segments`,
				area: "manifest",
				verdict: "SKIP",
				detail:
					"Writer identity and delivery bytes are checked separately; exact selected segment indexes require provider index metadata that was not collected",
			});
	}
	return checks;
}

export function dashExternalSubtitleChecks(
	id: string,
	expected: readonly ExternalSubtitle[],
	parsed: ParsedDash,
): Check[] {
	const available = [...parsed.representations];
	return expected.flatMap((subtitle, index) => {
		const found = available.findIndex(
			(row) =>
				row.kind === "text" &&
				row.baseUrl === subtitle.url &&
				row.language === subtitle.language,
		);
		if (found >= 0) available.splice(found, 1);
		return [
			check(
				`${id}:external-subtitle:${index}:reference`,
				found >= 0,
				"External DASH subtitles must retain the configured URL and language",
			),
			unverified(`${id}:external-subtitle:${index}:content`),
		];
	});
}
