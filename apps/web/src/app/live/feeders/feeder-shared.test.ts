import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { messagesFor, translate } from "@/lib/i18n";
import type { Translator } from "@/lib/i18n/context";
import {
	defaultFeederTarget,
	feederCreateBody,
	feederFailureMessage,
	feederSwitchPhase,
	feederTargetFields,
	isActiveFeederStatus,
	isOccupyingFeederSession,
	isStoppableFeederSession,
	parseLoopBoundary,
	reseedFeederTarget,
} from "./feeder-shared";

const en: Translator = (key, values) =>
	translate(messagesFor("en"), key, values);

/**
 * the panel's "something to switch from"
 * reads the channel's OCCUPANCY, the same three facts the create route's
 * admission counts, so a channel held by a terminal row whose ffmpeg is not
 * proven gone offers the switch instead of a 409 with no way forward.
 */
describe("isOccupyingFeederSession", () => {
	const at = "2026-08-30T00:00:00.000Z";
	const base = {
		status: "STOPPED" as const,
		pid: null,
		processGoneAt: null,
	};

	it("a terminal row with an unproven pid occupies — the audit's window", () => {
		expect(
			isOccupyingFeederSession({ ...base, status: "ERROR", pid: 4242 }),
		).toBe(true);
		expect(isActiveFeederStatus("ERROR")).toBe(false);
	});

	it("a terminal row that still holds the publisher claim occupies", () => {
		expect(isOccupyingFeederSession({ ...base, publisherClaimedAt: at })).toBe(
			true,
		);
		expect(
			isOccupyingFeederSession({
				...base,
				publisherClaimedAt: at,
				publisherReleasedAt: at,
			}),
		).toBe(false);
	});

	it("an active single-phase session occupies; an uncommitted two-phase one does not; a pre-claim server's missing columns read as not-held", () => {
		expect(isOccupyingFeederSession({ ...base, status: "PUSHING" })).toBe(true);
		expect(
			isOccupyingFeederSession({
				...base,
				status: "DOWNLOADING",
				commitAt: at,
			}),
		).toBe(false);
		expect(isOccupyingFeederSession(base)).toBe(false);
	});
});

/**
 *  — the two-phase switch as the lists and the create form see it.
 */
describe("feederSwitchPhase", () => {
	it("reads a two-phase session's hold off its columns, and nothing off an ordinary one", () => {
		const at = "2026-08-29T00:00:00.000Z";
		// Ordinary session: no commit instant → no phase, whatever else is set.
		expect(
			feederSwitchPhase({
				status: "DOWNLOADING",
				commitAt: null,
				readyAt: at,
				committedAt: null,
			}),
		).toBeNull();
		expect(feederSwitchPhase({ status: "DOWNLOADING" })).toBeNull();
		// Two-phase: downloading and gating.
		expect(
			feederSwitchPhase({
				status: "DOWNLOADING",
				commitAt: at,
				readyAt: null,
				committedAt: null,
			}),
		).toBe("STAGING");
		// Staged and holding — the only state that switches.
		expect(
			feederSwitchPhase({
				status: "DOWNLOADING",
				commitAt: at,
				readyAt: at,
				committedAt: null,
			}),
		).toBe("READY");
		// Past the hold: PUSHING (or the commit point taken) says the rest.
		expect(
			feederSwitchPhase({
				status: "DOWNLOADING",
				commitAt: at,
				readyAt: at,
				committedAt: at,
			}),
		).toBeNull();
		expect(
			feederSwitchPhase({
				status: "PUSHING",
				commitAt: at,
				readyAt: at,
				committedAt: at,
			}),
		).toBeNull();
		expect(
			feederSwitchPhase({
				status: "STOPPED",
				commitAt: at,
				readyAt: at,
				committedAt: null,
			}),
		).toBeNull();
	});
});

describe("feederCreateBody", () => {
	const form = {
		channelId: "00000000-0000-4000-8000-0000000000c1",
		source: { credentialId: "cred", bucket: "in", key: "ep1.mp4" },
		protocol: "RTMP" as const,
		rtmpUrl: "rtmp://203.0.113.7/live",
		streamKey: "sk",
		srtHost: "",
		srtPort: "",
		passphraseCredentialId: "",
	};

	it("carries switchFromActive only when the operator chose it AND a feeder is active", () => {
		expect(
			feederCreateBody({
				...form,
				switchFromActive: true,
				hasActiveFeeder: true,
			}),
		).toEqual({
			liveChannelId: form.channelId,
			source: form.source,
			protocol: "RTMP",
			target: { url: form.rtmpUrl, streamKey: "sk" },
			switchFromActive: true,
		});
		// A stale checkbox after the active feeder ended must not stage a
		// switch from nothing; and an unchecked box is an ordinary create.
		expect(
			feederCreateBody({
				...form,
				switchFromActive: true,
				hasActiveFeeder: false,
			}),
		).not.toHaveProperty("switchFromActive");
		expect(
			feederCreateBody({
				...form,
				switchFromActive: false,
				hasActiveFeeder: true,
			}),
		).not.toHaveProperty("switchFromActive");
	});

	it("builds the SRT target the route's schema accepts (port 0 for an empty field, vault ref only when set)", () => {
		expect(
			feederCreateBody({
				...form,
				protocol: "SRT_CALLER",
				srtHost: "203.0.113.7",
				srtPort: "2088",
				passphraseCredentialId: "pass",
				switchFromActive: false,
				hasActiveFeeder: false,
			}).target,
		).toEqual({
			host: "203.0.113.7",
			port: 2088,
			passphraseCredentialId: "pass",
		});
		expect(
			feederCreateBody({
				...form,
				protocol: "SRT_CALLER",
				srtHost: "203.0.113.7",
				switchFromActive: false,
				hasActiveFeeder: false,
			}).target,
		).toEqual({ host: "203.0.113.7", port: 0 });
	});
});

describe("defaultFeederTarget (prefill from channel ingest coordinates)", () => {
	it("builds the RTMP url from the encoder IP and suggests the channel streamKey", () => {
		expect(
			defaultFeederTarget({
				encoderIp: "203.0.113.99",
				streamKey: "myStreamKey",
			}),
		).toEqual({
			rtmpUrl: "rtmp://203.0.113.99/live",
			streamKey: "myStreamKey",
			srtHost: "203.0.113.99",
			srtPort: undefined,
		});
	});

	it("prefills the SRT port from the channel's listener port when known", () => {
		expect(
			defaultFeederTarget({
				encoderIp: "203.0.113.99",
				streamKey: "k",
				srtListenerPort: 2088,
			}).srtPort,
		).toBe(2088);
	});

	it("leaves everything empty before the channel has coordinates", () => {
		expect(defaultFeederTarget({ encoderIp: null, streamKey: null })).toEqual({
			rtmpUrl: "",
			streamKey: "",
			srtHost: "",
			srtPort: undefined,
		});
	});
});

describe("a STATIC ingest point offers no stream key (ledger #151)", () => {
	/**
	 * Measured against the real ingest, 2026-08-21. The prefill used to fall
	 * through to `channel.streamKey` — the PLAN's own `start.streamKey` — and
	 * `rtmps://live-input.bitmovin.com/live/<that>` is refused:
	 *
	 *   Server error: stream with rtmpApp='live' and streamkey='…'
	 *   is not ingestible or doesn't exist
	 *
	 * Bitmovin answers `streamKeyConfiguration: GENERATE` with a TEMPORARY
	 * StreamKey resource whose 22-character `value` is the only ingestible
	 * string, and that value is behind the per-key reveal GET. Two pushes with
	 * the wrong key left the encoder in WAITING_FOR_FIRST_CONNECT until ffmpeg
	 * gave up; the revealed value connected on the first try with nothing else
	 * changed.
	 */
	it("gives the fixed FQDN but leaves the key blank", () => {
		const target = defaultFeederTarget({
			encoderIp: "203.0.113.10",
			streamKey: "fromThePlan",
			ingestPoints: undefined,
			staticIngestPoints: [{ name: "ingest-a" }],
		});
		expect(target.rtmpUrl).toBe("rtmps://live-input.bitmovin.com/live");
		expect(
			target.streamKey,
			"offering the plan's key here hands the operator a value the ingest refuses",
		).toBe("");
	});

	it("still prefills the key for a DYNAMIC point, which does carry one", () => {
		// The negative direction: blanking every key would 'fix' the test above
		// and break the case that works.
		const target = defaultFeederTarget({
			encoderIp: "203.0.113.10",
			streamKey: "channelLevel",
			ingestPoints: [{ applicationName: "liveA", streamKey: "pointKey" }],
			staticIngestPoints: undefined,
		});
		expect(target.rtmpUrl).toBe("rtmp://203.0.113.10/liveA");
		expect(target.streamKey).toBe("pointKey");
	});
});

describe("reseedFeederTarget (late coordinate arrival must not clobber edits)", () => {
	const before = feederTargetFields({
		encoderIp: null,
		streamKey: null,
		ingestPoints: undefined,
		staticIngestPoints: undefined,
	});
	const after = feederTargetFields({
		encoderIp: "203.0.113.99",
		streamKey: "myStreamKey",
		srtListenerPort: 2088,
		ingestPoints: undefined,
		staticIngestPoints: undefined,
	});

	it("stringifies the prefill for the form inputs ('' = unknown port)", () => {
		expect(before).toEqual({
			rtmpUrl: "",
			streamKey: "",
			srtHost: "",
			srtPort: "",
		});
		expect(after).toEqual({
			rtmpUrl: "rtmp://203.0.113.99/live",
			streamKey: "myStreamKey",
			srtHost: "203.0.113.99",
			srtPort: "2088",
		});
	});

	it("reseeds untouched fields when encoderIp/streamKey land", () => {
		// User never typed — every field still equals the previous prefill.
		expect(reseedFeederTarget(before, before, after)).toEqual(after);
	});

	it("keeps the user's in-progress custom target, reseeding only the rest", () => {
		const edited = {
			...before,
			rtmpUrl: "rtmp://my-relay.example.com/live",
			srtPort: "7000",
		};
		expect(reseedFeederTarget(edited, before, after)).toEqual({
			rtmpUrl: "rtmp://my-relay.example.com/live",
			streamKey: after.streamKey,
			srtHost: after.srtHost,
			srtPort: "7000",
		});
	});

	it("respects edits that happen to follow a non-empty previous prefill", () => {
		const later = feederTargetFields({
			encoderIp: "198.51.100.7",
			streamKey: "myStreamKey",
			srtListenerPort: 2088,
			ingestPoints: undefined,
			staticIngestPoints: undefined,
		});
		const edited = { ...after, streamKey: "customKey" };
		expect(reseedFeederTarget(edited, after, later)).toEqual({
			rtmpUrl: later.rtmpUrl,
			streamKey: "customKey",
			srtHost: later.srtHost,
			srtPort: later.srtPort,
		});
	});
});

describe("parseLoopBoundary", () => {
	it("accepts the worker's {loopIndex, wallClock, streamTimeSec} shape", () => {
		expect(
			parseLoopBoundary({
				loopIndex: 3,
				wallClock: "2026-06-13T10:00:00.000Z",
				streamTimeSec: 12.5,
			}),
		).toEqual({
			loopIndex: 3,
			wallClock: "2026-06-13T10:00:00.000Z",
			streamTimeSec: 12.5,
		});
	});

	it("rejects malformed entries instead of rendering garbage rows", () => {
		expect(parseLoopBoundary(null)).toBeNull();
		expect(parseLoopBoundary("x")).toBeNull();
		expect(parseLoopBoundary({ loopIndex: "3", wallClock: "t" })).toBeNull();
	});
});

describe("feeder helpers", () => {
	it("treats CREATED/DOWNLOADING/PUSHING as active (stop-able, auto-refresh)", () => {
		expect(isActiveFeederStatus("CREATED")).toBe(true);
		expect(isActiveFeederStatus("DOWNLOADING")).toBe(true);
		expect(isActiveFeederStatus("PUSHING")).toBe(true);
		expect(isActiveFeederStatus("STOPPED")).toBe(false);
		expect(isActiveFeederStatus("ERROR")).toBe(false);
	});

	it("keeps a terminal session stoppable while its pid is unproven (audit 2026-08-29 CRITICAL-2)", () => {
		// The row a dead START job leaves behind: ERROR, pid kept, ffmpeg
		// still pushing. "Not active" is not "nothing to stop".
		expect(
			isStoppableFeederSession({
				status: "ERROR",
				pid: 4242,
				processGoneAt: null,
			}),
		).toBe(true);
		// Reclaimed — the kill ladder proved it gone.
		expect(
			isStoppableFeederSession({
				status: "ERROR",
				pid: 4242,
				processGoneAt: "2026-08-29T00:00:00.000Z",
			}),
		).toBe(false);
		// The ordinary terminal shape holds no process reference at all.
		expect(
			isStoppableFeederSession({
				status: "STOPPED",
				pid: null,
				processGoneAt: null,
			}),
		).toBe(false);
		// An active session stays stoppable even before a pid exists.
		expect(
			isStoppableFeederSession({
				status: "DOWNLOADING",
				pid: null,
				processGoneAt: null,
			}),
		).toBe(true);
		// A stale held claim is also work the stop path can repair once proof is
		// present (and remains a useful retry when the proof has not arrived yet).
		expect(
			isStoppableFeederSession({
				status: "STOPPED",
				pid: null,
				processGoneAt: "2026-08-29T00:00:00.000Z",
				publisherClaimedAt: "2026-08-29T00:00:00.000Z",
				publisherReleasedAt: null,
			}),
		).toBe(true);
	});

	it("keeps the feeder limit remediation without exposing route prose", () => {
		const err = new ApiError(
			409,
			"Active feeder session limit reached (7/7) — stop a session first; one worker slot stays reserved for stop jobs",
			{ code: "FEEDER_LIMIT_REACHED", current: 7, limit: 7 },
		);
		expect(feederFailureMessage(en, "Create", err)).toBe(
			"Create failed: Up to 7 file inputs can run at once (7 now). Stop an unused input, wait for shutdown to complete, and try again.",
		);
		expect(feederFailureMessage(en, "Create", err)).not.toContain(
			"worker slot",
		);
		expect(feederFailureMessage(en, "Stop", new Error("x"))).toBe(
			"Stop failed: Request failed. Try again.",
		);
	});
});

describe("REDUNDANT_RTMP prefill (the 0-objects channel)", () => {
	/**
	 * `live-redundant-rtmp` provisioned, reached RUNNING, accepted a feeder session, and wrote
	 * **zero objects**. Its input declares two ingest points — `liveA/primaryFeed` and
	 * `liveB/backupFeed` — and the prefill produced `rtmp://<ip>/live`, which no encoder on those
	 * applications is listening to.
	 *
	 * `ingest-coordinates.ts` already built `rtmp://<ip>/<applicationName>/<streamKey>` for the
	 * details screen, so the product knew the right shape and the feeder prefill did not. An
	 * operator clicking "feed this channel" got the same dead URL the harness did.
	 */
	it("uses the first ingest point's application name and stream key", () => {
		expect(
			defaultFeederTarget({
				encoderIp: "43.207.51.194",
				streamKey: "redundantKey",
				ingestPoints: [
					{ applicationName: "liveA", streamKey: "primaryFeed" },
					{ applicationName: "liveB", streamKey: "backupFeed" },
				],
			}),
		).toEqual({
			rtmpUrl: "rtmp://43.207.51.194/liveA",
			streamKey: "primaryFeed",
			srtHost: "43.207.51.194",
			srtPort: undefined,
		});
	});

	it("keeps /live and the channel key when there are no ingest points", () => {
		// The simple-RTMP path must not regress: most channels have no ingest points at all.
		expect(
			defaultFeederTarget({ encoderIp: "10.0.0.1", streamKey: "abc" }),
		).toEqual({
			rtmpUrl: "rtmp://10.0.0.1/live",
			streamKey: "abc",
			srtHost: "10.0.0.1",
			srtPort: undefined,
		});
	});

	it("falls back to /live and the channel key when a point carries neither", () => {
		// A point with blank fields must not produce `rtmp://ip/` or an empty stream key.
		expect(
			defaultFeederTarget({
				encoderIp: "10.0.0.1",
				streamKey: "abc",
				ingestPoints: [{ applicationName: "  ", streamKey: null }],
			}),
		).toEqual({
			rtmpUrl: "rtmp://10.0.0.1/live",
			streamKey: "abc",
			srtHost: "10.0.0.1",
			srtPort: undefined,
		});
	});
});
