import type { LiveChannelPlanInput } from "@bitovp/core";
import type { WizardDrmRow } from "@/app/vod/new/build-plan";
export type LiveDrm = NonNullable<LiveChannelPlanInput["drm"]>[number];
/** The existing VOD editor edits public metadata; vault material never enters this state. */
export function liveDrmEditorRow(d: LiveDrm): WizardDrmRow {
	const common = {
		key: d.key,
		muxingKey: d.muxingKey,
		credentialId: d.credentialId,
		name: d.name,
	};
	if (d.kind === "SPEKE")
		return {
			...common,
			kind: d.kind,
			systemIds: d.systemIds,
			contentId: d.contentId,
			kid: d.kid,
			iv: d.iv,
		};
	if (d.kind === "FAIRPLAY")
		return { ...common, kind: d.kind, iv: d.iv, uri: d.uri };
	return {
		...common,
		kind: d.kind,
		kid: d.kid,
		encryptionMode: d.encryptionMode,
		widevinePssh: d.widevine?.pssh,
		playReadyLaUrl: d.playReady?.laUrl,
		playReadyPssh: d.playReady?.pssh,
		fairPlayIv: d.fairPlay?.iv,
		fairPlayUri: d.fairPlay?.uri,
	};
}
export function updateLiveDrmMetadata(d: LiveDrm, row: WizardDrmRow): LiveDrm {
	const common = {
		key: d.key,
		muxingKey: d.muxingKey,
		destination: d.destination,
		credentialId: row.credentialId,
		name: d.name,
	};
	if (row.kind === "SPEKE")
		return {
			...common,
			kind: row.kind,
			systemIds: row.systemIds,
			contentId: row.contentId,
			kid: row.kid,
			iv: row.iv,
		};
	if (row.kind === "FAIRPLAY")
		return { ...common, kind: row.kind, iv: row.iv, uri: row.uri };
	return {
		...common,
		kind: row.kind,
		kid: row.kid,
		encryptionMode: row.encryptionMode,
		ivSize:
			d.kind === "CENC" && d.encryptionMode === row.encryptionMode
				? d.ivSize
				: row.encryptionMode === "CBC"
					? "IV_16_BYTES"
					: "IV_8_BYTES",
		widevine: row.widevinePssh ? { pssh: row.widevinePssh } : undefined,
		playReady:
			row.playReadyLaUrl || row.playReadyPssh
				? { laUrl: row.playReadyLaUrl, pssh: row.playReadyPssh }
				: undefined,
		fairPlay:
			row.fairPlayIv || row.fairPlayUri
				? { iv: row.fairPlayIv ?? "", uri: row.fairPlayUri ?? "" }
				: undefined,
	};
}
