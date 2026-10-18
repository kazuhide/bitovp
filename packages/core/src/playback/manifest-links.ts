import type { LiveChannelPlan } from "../live/schema";
import { joinFilePath } from "../plan/compiler";
import type { Acl, EncodingPlan, PlanOutput } from "../plan/schema";
import {
	mslEdgeManifestUrl,
	type PublicUrlCredential,
	type PublicUrlReason,
	type PublicUrlResult,
	publicObjectUrl,
} from "./public-url";

/** Bucket (or Azure container) an output writes to; null when it has neither. */
export function planOutputBucket(output: PlanOutput): string | null {
	switch (output.kind) {
		case "S3":
		case "GENERIC_S3":
		case "GCS":
		case "GCS_SERVICE_ACCOUNT":
			return output.bucket;
		case "AZURE":
			return output.container;
		case "SFTP":
		case "LIVE_MEDIA_INGEST":
			return null;
		case "AKAMAI_MSL":
			// : MSL is an INGEST target, not an object store. There
			// is no bucket, so no public OBJECT URL can be derived. Playback
			// comes from the Akamai property in front of the stream, which since
			// 2026-09-02 the credential may declare as `edgeBaseUrl` — `linksFor`
			// takes that route; the bucket answer here stays null, same as SFTP.
			return null;
		case "AKAMAI_NETSTORAGE":
			// : a NetStorage upload account holds no bucket — the
			// account IS the container. Objects are served through whatever
			// Akamai property is mapped to the CP code, which this app is not
			// told about, so there is no URL to derive here either.
			return null;
		default: {
			const exhaustive: never = output;
			throw new Error(`Unknown output kind ${JSON.stringify(exhaustive)}`);
		}
	}
}

export type ManifestPlaybackLink = {
	key: string;
	kind: "HLS" | "DASH" | "SMOOTH";
	label: string;
	/** Playable URL when derivable; otherwise null with `reason` set. */
	url: string | null;
	/** Origin path, for copying regardless of playability. */
	path: string;
	via: PublicUrlResult["via"];
	reason?: PublicUrlReason;
};

/**
 * Manifest-level entry point: every manifest in a plan paired with the URL a
 * player could load it from.
 *
 * Note what decides the URL shape — the **credential's provider**, not the
 * plan output's `kind`. One `GENERIC_S3` output can be backed by Akamai, OCI
 * or a MinIO, and `S3` can be key-based or role-based; keying off the output
 * kind (as the S3-only predecessor did) cannot tell those apart.
 */
export function manifestPlaybackLinks(
	plan: EncodingPlan,
	credentials: readonly ({ id: string } & PublicUrlCredential)[],
): ManifestPlaybackLink[] {
	return linksFor(
		plan.manifests.map((manifest) => ({
			key: manifest.key,
			kind: manifest.kind,
			label: manifest.name,
			// SMOOTH publishes a server and a client manifest; the server one is
			// the addressable entry point, matching the VOD detail view.
			filename:
				manifest.kind === "SMOOTH"
					? manifest.serverManifestName
					: manifest.manifestName,
			destination: manifest.destination,
		})),
		plan.outputs,
		credentials,
	);
}

/**
 * The same derivation for a LIVE channel plan .
 *
 * `destinationSchema` and `planOutputSchema` are shared with VOD, so this is
 * genuinely one helper rather than a parallel one: a live channel's HLS/DASH
 * manifests carry `key`/`kind`/`name`/`manifestName`/`destination` in exactly
 * the shape the VOD path reads. Live has no SMOOTH.
 */
export function liveManifestPlaybackLinks(
	plan: LiveChannelPlan,
	credentials: readonly ({ id: string } & PublicUrlCredential)[],
): ManifestPlaybackLink[] {
	return linksFor(
		plan.liveManifests.map((manifest) => ({
			key: manifest.key,
			kind: manifest.kind,
			label: manifest.name,
			filename: manifest.manifestName,
			destination: manifest.destination,
		})),
		plan.outputs,
		credentials,
	);
}

type ManifestLike = {
	key: string;
	kind: "HLS" | "DASH" | "SMOOTH";
	label: string;
	filename: string;
	destination: { outputKey: string; path: string; acl?: Acl };
};

function linksFor(
	manifests: readonly ManifestLike[],
	outputs: readonly PlanOutput[],
	credentials: readonly ({ id: string } & PublicUrlCredential)[],
): ManifestPlaybackLink[] {
	return manifests.map((manifest) => {
		const output = outputs.find(
			(o) => o.key === manifest.destination.outputKey,
		);
		/**
		 * `joinFilePath`, not concatenation: the plan schema does not force a
		 * trailing slash on `destination.path`, and the LIVE wizard does not
		 * produce one — `output/live-rtmp-simple` + `stream.m3u8` concatenated
		 * gives `output/live-rtmp-simplestream.m3u8`. Bitmovin treats the path as
		 * a directory, which is why `expected-live.ts` normalises it the same way.
		 * Every VOD fixture happens to end in `/`, so the corpus never showed it.
		 */
		const path = joinFilePath(manifest.destination.path, manifest.filename);
		// The lookup is guarded by the FIELD rather than by the kind — a kind
		// list here would need editing every time the union grows. (It used to
		// say AKAMAI_MSL "is the one output with no credential"; since the
		// 2026-08-19 remodel it has one, and the field guard is what kept this
		// correct through that change.)
		const credential =
			output && "credentialId" in output
				? credentials.find((c) => c.id === output.credentialId)
				: undefined;
		// MSL has no object to address: the link is the credential's declared
		// Akamai delivery root plus the manifest NAME (not the ingest path — the
		// edge serves the event root). Every other kind is an object URL.
		const derived =
			output?.kind === "AKAMAI_MSL"
				? mslEdgeManifestUrl({ credential, manifestName: manifest.filename })
				: publicObjectUrl({
						credential,
						bucket: output ? planOutputBucket(output) : null,
						key: path,
						acl: manifest.destination.acl,
					});
		return {
			key: manifest.key,
			kind: manifest.kind,
			label: manifest.label,
			path,
			url: derived.url,
			via: derived.via,
			...(derived.reason ? { reason: derived.reason } : {}),
		};
	});
}
