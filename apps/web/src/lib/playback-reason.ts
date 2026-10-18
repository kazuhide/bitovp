import type { PublicUrlReason } from "@bitovp/core";
import type { MessageKey } from "@/lib/i18n";

/**
 * Renders a `PublicUrlReason` through the message catalogue.
 *
 * `packages/core` returns the reason as *data* precisely so this mapping can
 * exist: core prose in the UI is English-only prose in the UI, and the one
 * thing this project's i18n has repeatedly got wrong is a string that never
 * entered the catalogue. Every variant maps to a key, so a new reason variant
 * is a typecheck error here rather than an untranslated sentence on screen.
 */
export function playbackReasonMessage(reason: PublicUrlReason): {
	key: MessageKey;
	values?: Record<string, string>;
} {
	switch (reason.code) {
		case "NO_CREDENTIAL":
			return { key: "playback.reasonNoCredential" };
		case "NOT_PUBLIC":
			return { key: "playback.reasonNotPublic" };
		case "NO_PATTERN":
			switch (reason.provider) {
				case "AZURE_BLOB":
					return { key: "playback.reasonAzureNoAcl" };
				case "OCI_OBJECT_STORAGE":
					return { key: "playback.reasonOciCompatAuth" };
				case "SFTP":
					return { key: "playback.reasonSftpNoHttp" };
				default:
					return { key: "playback.reasonNoBuckets" };
			}
		case "MISSING_CONFIG":
			return {
				key: "playback.reasonMissingConfig",
				values: { field: reason.field },
			};
		case "MISSING_BASE_URL":
			return {
				key: "playback.reasonBadBaseUrl",
				values: { bucket: reason.bucket },
			};
		case "INSECURE_ENDPOINT":
			return { key: "playback.reasonInsecureEndpoint" };
		case "MSL_EDGE_URL_NOT_CONFIGURED":
			// The credential id is data for the link the list renders beside
			// this sentence, not for the sentence — an id is not a name.
			return { key: "playback.reasonMslEdgeUrlNotConfigured" };
		default: {
			const exhaustive: never = reason;
			throw new Error(`Unknown reason ${JSON.stringify(exhaustive)}`);
		}
	}
}
