import {
	type LiveToVodFamilyRecord,
	normalizeLiveToVodRecord,
	redactSecrets,
} from "@bitovp/core";
import { LIVE_TO_VOD_PUBLIC_PROJECTION } from "@/lib/live-to-vod-public";

const MAX_TECHNICAL_DETAIL_LENGTH = 2_000;

/**
 * Raw SDK errors can contain bearer credentials, local source paths and stack
 * frames. Even the ADMIN view gets a bounded diagnostic, never that raw text.
 */
function safeTechnicalDetail(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	return redactSecrets(value)
		.replace(
			/\b((?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi,
			"$1[REDACTED]",
		)
		.replace(/\b(bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
		.replace(
			/([?&](?:api[_-]?key|access[_-]?key|authorization|credential|password|passphrase|secret|signature|token)=)[^&#\s]+/gi,
			"$1[REDACTED]",
		)
		.replace(
			/\b((?:api[_-]?key|access[_-]?key|authorization|credential|password|passphrase|secret|signature|token)\s*[=:]\s*)[^\s,;]+/gi,
			"$1[REDACTED]",
		)
		.replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, "[PATH_REDACTED]")
		.replace(/^\s*at\s+.+$/gm, "[STACK_REDACTED]")
		.slice(0, MAX_TECHNICAL_DETAIL_LENGTH);
}

function publicFamily(family: LiveToVodFamilyRecord) {
	switch (family.status) {
		case "ERROR": {
			const {
				technicalDetail: _technical,
				error: _legacy,
				providerIdentity: _identity,
				createIntent: _createIntent,
				cleanup,
				...safe
			} = family;
			return {
				...safe,
				...(cleanup
					? {
							cleanup: {
								status: cleanup.status,
								requestedAt: cleanup.requestedAt,
								...(cleanup.status === "DELETE_CONFIRMED"
									? { confirmedAt: cleanup.confirmedAt }
									: {}),
								...(cleanup.errorCode ? { errorCode: cleanup.errorCode } : {}),
							},
						}
					: {}),
			};
		}
		case "SKIPPED_UNSUPPORTED": {
			const { technicalDetail: _technical, reason: _legacy, ...safe } = family;
			return safe;
		}
		case "PENDING": {
			const {
				providerIdentity: _identity,
				createIntent: _createIntent,
				...safe
			} = family;
			return safe;
		}
		case "CREATED":
		case "RUNNING":
		case "FINISHED": {
			const { providerIdentity: _identity, ...safe } = family;
			return safe;
		}
	}
}

function safeCreateIntent<T extends { technicalDetail?: string } | undefined>(
	createIntent: T,
): T {
	if (!createIntent?.technicalDetail) {
		return createIntent;
	}
	return {
		...createIntent,
		technicalDetail: safeTechnicalDetail(createIntent.technicalDetail),
	} as T;
}

function adminFamily(family: LiveToVodFamilyRecord): LiveToVodFamilyRecord {
	switch (family.status) {
		case "PENDING":
			return {
				...family,
				...(family.createIntent
					? { createIntent: safeCreateIntent(family.createIntent) }
					: {}),
			};
		case "ERROR": {
			const { technicalDetail, error, createIntent, cleanup, ...safe } = family;
			const detail = safeTechnicalDetail(technicalDetail ?? error);
			return {
				...safe,
				...(detail ? { technicalDetail: detail } : {}),
				...(createIntent
					? { createIntent: safeCreateIntent(createIntent) }
					: {}),
				...(cleanup
					? {
							cleanup: {
								...cleanup,
								...(cleanup.technicalDetail
									? {
											technicalDetail: safeTechnicalDetail(
												cleanup.technicalDetail,
											),
										}
									: {}),
							},
						}
					: {}),
			};
		}
		case "SKIPPED_UNSUPPORTED": {
			const { technicalDetail, reason, ...safe } = family;
			const detail = safeTechnicalDetail(technicalDetail ?? reason);
			return {
				...safe,
				...(detail ? { technicalDetail: detail } : {}),
			};
		}
		default:
			return family;
	}
}

/**
 * Server-side DTO projection. Stable codes cross every role boundary, while
 * provider identity and bounded/redacted diagnostics cross only for a trusted
 * password session or a principal the proxy resolved as ADMIN.
 */
export function liveToVodForRole(raw: unknown, isAdmin: boolean) {
	const record = normalizeLiveToVodRecord(raw);
	if (!record) {
		return record;
	}
	if (isAdmin) {
		const { technicalDetail, error, families, ...safe } = record;
		const detail = safeTechnicalDetail(technicalDetail ?? error);
		return {
			...safe,
			...(detail ? { technicalDetail: detail } : {}),
			...(families ? { families: families.map(adminFamily) } : {}),
		};
	}
	const {
		technicalDetail: _technical,
		error: _legacy,
		families,
		revision: _revision,
		queueJobId: _queueJobId,
		outputId: _outputId,
		priorManifests: _priorManifests,
		...safe
	} = record;
	return {
		...safe,
		projection: LIVE_TO_VOD_PUBLIC_PROJECTION,
		...((safe.status === "ERROR" || safe.status === "PARTIAL") &&
		safe.errorCode === undefined
			? { errorCode: "L2V_PROVIDER_STATUS_FAILED" as const }
			: {}),
		...(families ? { families: families.map(publicFamily) } : {}),
	};
}

/** : which manifest families the CURRENT recording can carry. */
export type LiveToVodFamiliesView = {
	supported: ("HLS" | "DASH")[];
	unsupported: { family: "HLS" | "DASH"; technicalDetail?: string }[];
};

/**
 * The family set the panel preselects, derived server-side from the same
 * step log the POST route judges, so a checked box never 422s. The reasons
 * are provider-facing English (muxing kinds, provider error codes) and cross
 * only for a principal that may read technical detail.
 */
export function liveToVodFamiliesForRole(
	support: {
		supported: readonly ("HLS" | "DASH")[];
		unsupported: readonly { family: "HLS" | "DASH"; reason: string }[];
	},
	isAdmin: boolean,
): LiveToVodFamiliesView {
	return {
		supported: [...support.supported],
		unsupported: support.unsupported.map((entry) => ({
			family: entry.family,
			...(isAdmin ? { technicalDetail: entry.reason } : {}),
		})),
	};
}
