"use client";

import type { PlayerClientConfig, SceneAnalysisDocument } from "@bitovp/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import {
	type PlaybackCorsResult,
	playbackCorsMessage,
} from "@/lib/playback-cors-message";
import { libraryMp4PlaybackError } from "@/lib/playback-mp4-status";
import { SubjectOverlay } from "./subject-overlay";

/**
 * How long a missing live manifest stays "not yet": 12 x 5s = 60s of grace.
 * First publish was measured at 31.8s on one real channel and 131.3s on another,
 * so this covers the common case and lets the slow one become an honest error
 * rather than an indefinite spinner.
 */
/**
 * Exported so tests can exhaust the grace period by derivation rather than by a
 * literal: a test that hardcodes "13 errors" stops exercising the grace the moment
 * this number moves, and fails for a reason that reads like a player bug.
 */
export const FIRST_SEGMENT_ATTEMPTS = 12;
const FIRST_SEGMENT_RETRY_MS = 5_000;
/** Shaka util.Error.Code.BAD_HTTP_STATUS in the pinned 5.2.8 API. */
const SHAKA_BAD_HTTP_STATUS = 1001;
/** Shaka net.NetworkingEngine.RequestType.MANIFEST in the pinned 5.2.8 API. */
const SHAKA_REQUEST_TYPE_MANIFEST = 0;
const SHAKA_REQUEST_TYPE_SEGMENT = 1;
/** Shaka util.Error.Severity.RECOVERABLE in the pinned 5.2.8 API. */
const SHAKA_RECOVERABLE = 1;
/** Keep transient Shaka retries visible before declaring delivery stalled. */
export const SHAKA_RECOVERY_STALL_MS = 60_000;

function isAccessDeniedStatus(status: unknown): boolean {
	return status === 401 || status === 403;
}

/** These media-network errors expose data.statusCode in the installed Player v8. */
function isBitmovinMediaAccessDenied(value: unknown): boolean {
	const error = value as
		| { code?: unknown; data?: { statusCode?: unknown } }
		| null
		| undefined;
	return (
		(error?.code === 1208 || error?.code === 1400) &&
		isAccessDeniedStatus(error.data?.statusCode)
	);
}

export type PlaybackSurfaceProps = {
	url: string | null;
	kind: "HLS" | "DASH" | "MP4" | null;
	/**
	 *  (design §4.2): the NARROW config object — never the
	 * settings row. Absent = the open-source default, which is also what
	 * `bitmovin` without a key degrades to (decided in toPlayerClientConfig,
	 * not here). Server
	 * pages read it via readPlayerClientConfig and thread it down, so it is
	 * present from the FIRST render — no mount-native-then-flip.
	 */
	player?: PlayerClientConfig;
	/**
	 * Analytics dimensions (UI-DESIGN §2): videoId = encodingId — the
	 * first-class filter — with the human title beside it and the local job
	 * id in customData5. Collected only when the config carries an
	 * analyticsLicenseKey, and only when Bitmovin Player is selected. The
	 * open-source preview never loads a Bitmovin Analytics adapter. These
	 * numbers are NOT audience QoE — they measure
	 * the network of whoever ran the check; their value is comparative.
	 */
	analyticsMeta?: {
		videoId: string;
		title?: string;
		customData5?: string;
	};
	/**
	 * Identifies the manifest for the CORS diagnosis, which the server resolves
	 * from the plan. Omitted when the caller cannot name it (live, previews) —
	 * then a failure is reported without one.
	 */
	diagnose?: {
		scope: "vod" | "live";
		/** Job id, or channel id for the live scope. */
		id: string;
		manifestKey: string;
	};
	/**
	 * Start playing on mount. The inline preview does (muted), because a
	 * verification tool's job is to show the stream actually decoding rather
	 * than that a manifest parsed.
	 */
	autoPlay?: boolean;
	/** Absolute media seconds; increment requestId to seek to the same time again. */
	seekRequest?: { seconds: number; requestId: number };
	sceneAnalysis?: SceneAnalysisDocument;
	/** Actual media clock; null while unavailable or playback has failed. */
	onTimeChange?: (time: number | null) => void;
	/**
	 * Treat an early manifest failure as "not yet" rather than an error.
	 *
	 * A live channel's manifest 404s between START and the first segment write —
	 * measured at 31.8s on a real RTMP channel — and that is a normal state, not a
	 * fault . Without this the panel reports a fatal
	 * networkError and asks the CORS question about a bucket that is fine.
	 */
	waitForFirstSegment?: boolean;
};

/**
 * The player itself: hls.js for HLS (native on Safari), Shaka Player for DASH,
 * both dynamically imported so they stay out of the main bundle.
 *
 * Extracted from `player-dialog.tsx` so the inline preview panel and the
 * enlarged dialog are the same player with the same failure reporting — two
 * implementations would drift, and the one that drifts is the one nobody
 * watches.
 *
 * On failure it asks the server whether the bucket's CORS configuration is the
 * cause : the measured gap on the real output bucket
 * was `Access-Control-Expose-Headers` , which a player can only report
 * as a generic network error. The check runs *after* a failure, so a working
 * playback never pays for an outbound storage call.
 */
export function PlaybackSurface(props: PlaybackSurfaceProps) {
	const [attempt, setAttempt] = useState(0);
	return (
		<PlaybackAttempt
			{...props}
			key={attempt}
			onRetry={() => setAttempt((value) => value + 1)}
		/>
	);
}

/** Explicit retry replaces only this player, including its timers and diagnosis. */
function PlaybackAttempt({
	url,
	kind,
	diagnose,
	autoPlay = false,
	waitForFirstSegment = false,
	player,
	analyticsMeta,
	seekRequest,
	sceneAnalysis,
	onTimeChange,
	onRetry,
}: PlaybackSurfaceProps & { onRetry: () => void }) {
	const { t } = useT();
	/**
	 * State, not a ref — and this is load-bearing.
	 *
	 * Radix's `Dialog.Portal` mounts its children through `Presence`, one commit
	 * AFTER this component's effects run. A `useRef` is therefore still null when
	 * the effect fires, and since a ref mutation does not re-render, the effect
	 * never runs again: the element mounts with no `src` and nothing ever plays.
	 * That is what the player did until 2026-08-11 — an empty black box with
	 * controls, which is why design §12 suspected it had never played a real
	 * output. A callback ref stored in state re-runs the effect once the element
	 * exists, wherever it is mounted.
	 */
	const [video, setVideo] = useState<HTMLVideoElement | null>(null);
	/** Bitmovin Player renders its OWN video element into this container. */
	const [container, setContainer] = useState<HTMLDivElement | null>(null);
	const [playbackError, setPlaybackError] = useState<string | null>(null);
	const [mediaTime, setMediaTime] = useState<number | null>(null);
	const [showScenes, setShowScenes] = useState(true);
	const [showSubjects, setShowSubjects] = useState(false);
	const [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null);
	const hasSubjects = useMemo(
		() =>
			sceneAnalysis?.scenes.some((scene) =>
				scene.shots.some((shot) => shot.mainSubjects.length > 0),
			),
		[sceneAnalysis],
	);
	const clockListener = useRef(onTimeChange);
	const sceneClockEnabled = useRef(false);
	useEffect(() => {
		clockListener.current = onTimeChange;
		sceneClockEnabled.current = !!sceneAnalysis || !!onTimeChange;
	}, [sceneAnalysis, onTimeChange]);
	useEffect(() => {
		clockListener.current?.(playbackError ? null : mediaTime);
	}, [mediaTime, playbackError]);
	const activeScene =
		!playbackError && showScenes && mediaTime !== null
			? sceneAnalysis?.scenes.find(
					(scene) =>
						mediaTime >= scene.startInSeconds && mediaTime < scene.endInSeconds,
				)
			: undefined;
	const updateMediaTime = (element: HTMLVideoElement) => {
		if (!sceneClockEnabled.current) return;
		setMediaTime(
			element.readyState >= 1 && Number.isFinite(element.currentTime)
				? element.currentTime
				: null,
		);
	};
	/** Attempt count while a live manifest has not appeared yet; null otherwise. */
	const [waiting, setWaiting] = useState<number | null>(null);
	/** Recoverable Shaka errors remain non-terminal but never false-green. */
	const [recovery, setRecovery] = useState<"retrying" | "stalled" | null>(null);
	const [recoveryAccessDenied, setRecoveryAccessDenied] = useState(false);
	const [cors, setCors] = useState<PlaybackCorsResult | "failed" | null>(null);
	const requestedSeek = useRef(seekRequest);
	const applySeek = useRef<(() => void) | null>(null);
	const seekSeconds = seekRequest?.seconds;
	const seekRequestId = seekRequest?.requestId;
	useEffect(() => {
		requestedSeek.current =
			seekSeconds === undefined || seekRequestId === undefined
				? undefined
				: { seconds: seekSeconds, requestId: seekRequestId };
		applySeek.current?.();
	}, [seekSeconds, seekRequestId]);
	const bindSeek = useCallback((seek: (seconds: number) => boolean) => {
		let applied: number | undefined;
		const apply = () => {
			const request = requestedSeek.current;
			if (
				!request ||
				request.requestId === applied ||
				!Number.isFinite(request.seconds) ||
				request.seconds < 0
			)
				return;
			if (seek(request.seconds)) applied = request.requestId;
		};
		applySeek.current = apply;
		apply();
		return () => {
			if (applySeek.current === apply) applySeek.current = null;
		};
	}, []);

	/**
	 * One diagnosis per source: a fatal hls.js error can fire repeatedly as it
	 * retries, and each would otherwise be an outbound GetBucketCors.
	 */
	const asked = useRef(false);
	/** Invalidates a diagnosis response when playback recovers or the source changes. */
	const diagnosisEpoch = useRef(0);
	const mp4Probe = useRef<AbortController | null>(null);
	useEffect(
		() => () => {
			diagnosisEpoch.current += 1;
			mp4Probe.current?.abort();
		},
		[],
	);
	const clearDiagnosis = useCallback(() => {
		diagnosisEpoch.current += 1;
		asked.current = false;
		mp4Probe.current?.abort();
		mp4Probe.current = null;
		setCors(null);
	}, []);
	/**
	 * Depend on the PRIMITIVES, not on `diagnose`'s identity.
	 *
	 * Both callers pass a JSX object literal — the natural thing to write — so
	 * `diagnose` is a new object on every render. With `[diagnose]` here,
	 * `diagnoseNow` was new every render, and it sits in the player effect's
	 * dependency list: the effect tore down and rebuilt hls.js/Shaka on every
	 * parent re-render. The job page polls every 5s while RUNNING and the channel
	 * page every 15s while active — the only two states in which this panel shows
	 * a *moving* source — so playback restarted from zero (VOD) or re-joined the
	 * live edge (live) on every poll, and the `asked` guard below was reset each
	 * time, re-firing `GetBucketCors` (a credential decrypt plus an outbound S3
	 * call) per poll.
	 *
	 * Fixed here rather than by memoising at the call sites, because a future
	 * caller writing the obvious literal must not be able to bring it back.
	 */
	const scope = diagnose?.scope;
	const diagnoseId = diagnose?.id;
	const manifestKey = diagnose?.manifestKey;
	const diagnoseNow = useCallback(() => {
		if (asked.current) return;
		if (kind === "MP4") {
			if (!url) return;
			asked.current = true;
			const epoch = diagnosisEpoch.current;
			const controller = new AbortController();
			mp4Probe.current = controller;
			void libraryMp4PlaybackError(url, controller.signal).then((error) => {
				if (
					error &&
					!controller.signal.aborted &&
					epoch === diagnosisEpoch.current
				)
					setPlaybackError(
						t(
							error === "missing"
								? "playback.mp4FileMissing"
								: "playback.storageAccessDenied",
						),
					);
			});
			return;
		}
		if (!scope || !diagnoseId || !manifestKey) {
			return;
		}
		asked.current = true;
		const epoch = diagnosisEpoch.current;
		apiFetch<PlaybackCorsResult>(
			`/api/${
				scope === "live" ? "live-channels" : "encoding-jobs"
			}/${diagnoseId}/playback-cors?manifestKey=${encodeURIComponent(
				manifestKey,
			)}`,
		)
			.then((result) => {
				if (epoch === diagnosisEpoch.current) {
					setCors(result);
				}
			})
			.catch(() => {
				if (epoch === diagnosisEpoch.current) {
					setCors("failed");
				}
			});
	}, [kind, url, t, scope, diagnoseId, manifestKey]);

	const useBitmovin = player?.provider === "bitmovin";
	const playerLicenseKey =
		player?.provider === "bitmovin" ? player.playerLicenseKey : undefined;
	const analyticsKey =
		player?.provider === "bitmovin" ? player.analyticsLicenseKey : undefined;
	const analyticsVideoId = analyticsMeta?.videoId;
	const analyticsTitle = analyticsMeta?.title;
	const analyticsJobId = analyticsMeta?.customData5;

	/**
	 * The Bitmovin Player branch . Dynamically
	 * imported like hls.js/Shaka so it stays out of the main bundle; it
	 * builds its own <video> inside the container div. The licence check
	 * calls out to Bitmovin and is domain-locked — that failure is opaque by
	 * default, so it is surfaced EXPLICITLY as "this domain is not
	 * authorised" instead of reading as a broken stream.
	 */
	useEffect(() => {
		if (!useBitmovin) {
			return;
		}
		setPlaybackError(null);
		setMediaTime(null);
		clearDiagnosis();
		setWaiting(null);
		setRecovery(null);
		setRecoveryAccessDenied(false);
		if (!url || !kind || !container || !playerLicenseKey) {
			return;
		}
		let cancelled = false;
		let cleanup = () => {};
		(async () => {
			const { Player, PlayerEvent } = await import("bitmovin-player");
			// The skin ships as its own package (
			// HIGH-14): left to itself the player fetches
			// `bitmovinplayer-ui.js` / `.css` from beside its own script, which
			// under Next's chunk path is a 404 on every deployment — a player
			// with no controls, silently. `ui: false` stops that fetch and the
			// UI package builds the default skin from the bundle instead.
			const { UIFactory } = await import("bitmovin-player-ui");
			if (cancelled) {
				return;
			}
			const instance = new Player(container, {
				key: playerLicenseKey,
				ui: false,
				playback: { autoplay: autoPlay, muted: autoPlay },
				// UI-DESIGN §2: the full bundle carries Analytics; config-only.
				// cdnProvider as an environment marker is a deliberate misuse —
				// harmless because the separate licence key already segregates
				// the data (UI-DESIGN §2).
				...(analyticsKey && analyticsVideoId
					? {
							analytics: {
								key: analyticsKey,
								videoId: analyticsVideoId,
								...(analyticsTitle ? { title: analyticsTitle } : {}),
								...(analyticsJobId ? { customData5: analyticsJobId } : {}),
								cdnProvider: "bitovp-preview",
							},
						}
					: {}),
			});
			let licensingRefused = false;
			const onError = (event: {
				code?: number;
				name?: string;
				data?: unknown;
			}) => {
				if (cancelled) return;
				// Licensing refusals: the web player's LICENSING error family.
				// Detected by name AND the 1016/1017 codes so a renamed enum
				// in a future SDK still matches one of the two. Confirmed
				// against the real licence in the #59 verification run.
				const name = String(event?.name ?? "").toLowerCase();
				if (
					name.includes("licens") ||
					event?.code === 1016 ||
					event?.code === 1017
				) {
					licensingRefused = true;
					setPlaybackError(t("playback.licenseDomainRefused"));
					return;
				}
				setPlaybackError(
					isBitmovinMediaAccessDenied(event)
						? t("playback.accessDenied")
						: t("uiX.hlsPlaybackFailed", {
								type: `bitmovin ${event?.code ?? "?"} ${event?.name ?? ""}`,
							}),
				);
				diagnoseNow();
			};
			instance.on(PlayerEvent.Error, onError as never);
			const ui = UIFactory.buildUI(instance);
			let loaded = false;
			try {
				await instance.load(
					kind === "MP4"
						? { progressive: [{ url, type: "video/mp4" }] }
						: kind === "HLS"
							? { hls: url }
							: { dash: url },
				);
				loaded = true;
			} catch (err) {
				// load rejects on licensing failures too; the Error event
				// handler above has usually spoken first — keep its message.
				if (!cancelled) {
					const message = err instanceof Error ? err.message : "";
					const licenseFailure = licensingRefused || /licens/i.test(message);
					setPlaybackError((previous) => {
						if (previous) {
							return previous;
						}
						return licenseFailure
							? t("playback.licenseDomainRefused")
							: isBitmovinMediaAccessDenied(err)
								? t("playback.accessDenied")
								: t("ui.playerFailedToLoad");
					});
					if (!licenseFailure) diagnoseNow();
				}
			}
			// review-330: an unmount DURING load ran the effect's cleanup while
			// it was still the no-op below — player AND skin leaked, because
			// nothing ran the real teardown once load resolved. The same
			// guard as the one before construction, at the other await.
			if (cancelled) {
				instance.off(PlayerEvent.Error, onError as never);
				ui.release();
				void instance.destroy();
				return;
			}
			const unbindSeek = loaded
				? bindSeek((seconds) => {
						if (cancelled) return false;
						return instance.seek(seconds);
					})
				: () => {};
			const onTimeChanged = ({ time }: { time: number }) => {
				if (!cancelled && sceneClockEnabled.current)
					setMediaTime(Number.isFinite(time) ? time : null);
			};
			if (loaded) instance.on(PlayerEvent.TimeChanged, onTimeChanged);
			cleanup = () => {
				unbindSeek();
				instance.off(PlayerEvent.TimeChanged, onTimeChanged);
				instance.off(PlayerEvent.Error, onError as never);
				ui.release();
				void instance.destroy();
			};
		})().catch((err) => {
			if (cancelled) return;
			setPlaybackError(
				err instanceof Error ? err.message : t("ui.playerFailedToLoad"),
			);
		});
		return () => {
			cancelled = true;
			cleanup();
		};
	}, [
		useBitmovin,
		url,
		kind,
		container,
		playerLicenseKey,
		autoPlay,
		t,
		diagnoseNow,
		analyticsKey,
		analyticsVideoId,
		analyticsTitle,
		analyticsJobId,
		clearDiagnosis,
		bindSeek,
	]);

	useEffect(() => {
		if (useBitmovin) {
			return;
		}
		setPlaybackError(null);
		setMediaTime(null);
		clearDiagnosis();
		setWaiting(null);
		setRecovery(null);
		setRecoveryAccessDenied(false);
		if (!url || !kind || !video) {
			return;
		}
		let cleanup = () => {};
		let cancelled = false;
		let sourceAttached = false;
		const unbindSeek = bindSeek((seconds) => {
			if (cancelled || !sourceAttached || video.readyState < 1) return false;
			video.currentTime = Number.isFinite(video.duration)
				? Math.min(seconds, video.duration)
				: seconds;
			return true;
		});
		const onMetadata = () => applySeek.current?.();
		video.addEventListener("loadedmetadata", onMetadata);

		/**
		 * A native failure is otherwise INVISIBLE: only library-managed errors were
		 * reported, so the native branch could die and leave a black element with
		 * no message. Measured: Chrome/macOS answers `canPlayType` "maybe" and then
		 * fails a live fMP4 HLS playlist with MEDIA_ERR_SRC_NOT_SUPPORTED.
		 */
		const onNativeError = () => {
			setPlaybackError(
				kind === "MP4"
					? t("ui.playerFailedToLoad")
					: t("uiX.hlsPlaybackFailed", {
							type: `media error ${video.error?.code ?? "?"}`,
						}),
			);
			diagnoseNow();
		};

		(async () => {
			if (kind === "MP4") {
				video.addEventListener("error", onNativeError);
				video.src = url;
				sourceAttached = true;
				onMetadata();
				cleanup = () => {
					video.removeEventListener("error", onNativeError);
					video.removeAttribute("src");
					video.load();
				};
				return;
			}
			if (kind === "HLS") {
				/**
				 * MSE FIRST, native as the fallback — the opposite of what this did.
				 *
				 * Chrome on macOS reports `canPlayType("application/vnd.apple.mpegurl")`
				 * as "maybe", so the native-first branch took it there. Probed against
				 * real output : native played
				 * the VOD stream but FAILED the LIVE one outright
				 * (MEDIA_ERR_SRC_NOT_SUPPORTED, 0s buffered) while hls.js played both.
				 * With no fallback after a native failure, live playback in Chrome was
				 * a dead element. hls.js is the path its own project recommends
				 * wherever MSE exists; native is for Safari/iOS, where it does not.
				 */
				const { default: Hls } = await import("hls.js");
				if (cancelled) {
					return;
				}
				if (!Hls.isSupported()) {
					const nativeHlsSupport =
						video.canPlayType("application/vnd.apple.mpegurl") ||
						video.canPlayType("application/x-mpegURL");
					if (!nativeHlsSupport) {
						setPlaybackError(t("playback.hlsUnsupported"));
						return;
					}
					video.addEventListener("error", onNativeError);
					video.src = url;
					sourceAttached = true;
					onMetadata();
					cleanup = () => {
						video.removeEventListener("error", onNativeError);
						video.removeAttribute("src");
						video.load();
					};
					return;
				}
				const hls = new Hls();
				// startLoad cannot reload a failed initial master: hls.js's
				// PlaylistLoader.startLoad is a no-op until loadSource dispatches it.
				// One independent deadline also bounds a retry that never responds.
				let attempts = 0;
				let firstMediaLoaded = false;
				let terminal = false;
				let retry: ReturnType<typeof setTimeout> | undefined;
				let deadline: ReturnType<typeof setTimeout> | undefined;
				const clearTimers = () => {
					clearTimeout(retry);
					clearTimeout(deadline);
					retry = undefined;
					deadline = undefined;
				};
				const fail = (
					type: string,
					initialManifestTimeout = false,
					status?: number,
				) => {
					if (cancelled || terminal) return;
					terminal = true;
					clearTimers();
					hls.stopLoad();
					setWaiting(null);
					setPlaybackError(
						initialManifestTimeout
							? t("playback.initialManifestTimeout")
							: type === "networkError" && isAccessDeniedStatus(status)
								? t("playback.accessDenied")
								: t("uiX.hlsPlaybackFailed", { type }),
					);
					diagnoseNow();
				};
				hls.on(Hls.Events.ERROR, (_event, data) => {
					if (cancelled || terminal || !data.fatal) {
						return;
					}
					// Only an initial master 404 supports this grace. Opaque network
					// failures/403s do not establish publication timing or CORS, and
					// failures after media arrives are no longer a first-segment wait.
					const initialManifest404 =
						waitForFirstSegment &&
						!firstMediaLoaded &&
						data.type === "networkError" &&
						data.details === "manifestLoadError" &&
						data.response?.code === 404;
					if (initialManifest404 && attempts < FIRST_SEGMENT_ATTEMPTS) {
						if (retry !== undefined) return;
						if (deadline === undefined) {
							deadline = setTimeout(
								() => fail("networkError", true),
								FIRST_SEGMENT_ATTEMPTS * FIRST_SEGMENT_RETRY_MS,
							);
						}
						attempts += 1;
						setWaiting(attempts);
						retry = setTimeout(() => {
							retry = undefined;
							if (!cancelled && !terminal && !firstMediaLoaded) {
								hls.loadSource(url);
							}
						}, FIRST_SEGMENT_RETRY_MS);
						return;
					}
					fail(
						data.type,
						initialManifest404 && attempts >= FIRST_SEGMENT_ATTEMPTS,
						data.response?.code,
					);
				});
				hls.on(Hls.Events.FRAG_LOADED, () => {
					if (cancelled || terminal) return;
					firstMediaLoaded = true;
					clearTimers();
					setWaiting(null);
				});
				hls.loadSource(url);
				hls.attachMedia(video);
				sourceAttached = true;
				onMetadata();
				cleanup = () => {
					clearTimers();
					hls.destroy();
				};
			} else {
				const { default: shaka } = await import("shaka-player");
				if (cancelled) {
					return;
				}
				shaka.polyfill.installAll();
				if (!shaka.Player.isBrowserSupported()) {
					setPlaybackError(t("playback.dashUnsupported"));
					return;
				}

				const shakaPlayer = new shaka.Player();
				let attempts = 0;
				let destroyed = false;
				let errorSurfaced = false;
				let recoveryActive = false;
				let pendingMediaTypes: Set<"audio" | "video"> | null = null;
				let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
				let loadPhase: "loading" | "retry-wait" | "loaded" | "terminal" =
					"loading";
				let retryTimer: ReturnType<typeof setTimeout> | undefined;
				let releaseRetry: (() => void) | undefined;

				const detailOf = (value: unknown): unknown => {
					if (!value || typeof value !== "object" || !("detail" in value)) {
						return value;
					}
					return (value as { detail?: unknown }).detail;
				};
				const isManifest404 = (value: unknown): boolean => {
					const detail = detailOf(value);
					if (!detail || typeof detail !== "object") {
						return false;
					}
					const error = detail as { code?: unknown; data?: unknown };
					return (
						error.code === SHAKA_BAD_HTTP_STATUS &&
						Array.isArray(error.data) &&
						Number(error.data[1]) === 404 &&
						Number(error.data[4]) === SHAKA_REQUEST_TYPE_MANIFEST
					);
				};
				const isMediaAccessDenied = (value: unknown): boolean => {
					const detail = detailOf(value) as
						| { code?: unknown; data?: unknown }
						| null
						| undefined;
					return (
						detail?.code === SHAKA_BAD_HTTP_STATUS &&
						Array.isArray(detail.data) &&
						isAccessDeniedStatus(detail.data[1]) &&
						(detail.data[4] === SHAKA_REQUEST_TYPE_MANIFEST ||
							detail.data[4] === SHAKA_REQUEST_TYPE_SEGMENT)
					);
				};
				const isRecoverable = (value: unknown): boolean => {
					const detail = detailOf(value);
					return (
						!!detail &&
						typeof detail === "object" &&
						(detail as { severity?: unknown }).severity === SHAKA_RECOVERABLE
					);
				};
				const stopRecoveryTimer = () => {
					if (recoveryTimer !== undefined) {
						clearTimeout(recoveryTimer);
						recoveryTimer = undefined;
					}
				};
				const stopRecovery = () => {
					if (!recoveryActive) {
						return false;
					}
					recoveryActive = false;
					pendingMediaTypes = null;
					stopRecoveryTimer();
					if (!cancelled) {
						setRecovery(null);
						setRecoveryAccessDenied(false);
					}
					return true;
				};
				const clearRecovery = () => {
					if (stopRecovery() && !cancelled) {
						clearDiagnosis();
					}
				};
				const startRecovery = () => {
					if (cancelled || errorSurfaced) {
						return;
					}
					const activeVariant = shakaPlayer
						.getVariantTracks()
						.find((track) => track.active);
					const expected = new Set<"audio" | "video">();
					if (activeVariant?.audioId != null) {
						expected.add("audio");
					}
					if (activeVariant?.videoId != null) {
						expected.add("video");
					}
					// During early load there may be no active track yet. In that narrow
					// case, the first real A/V append remains the best available proof.
					pendingMediaTypes = expected.size > 0 ? expected : null;
					// A new error invalidates earlier appends, but it must not slide the
					// episode deadline or a persistent outage could retry forever.
					if (recoveryActive) {
						return;
					}
					recoveryActive = true;
					setRecovery("retrying");
					recoveryTimer = setTimeout(() => {
						if (cancelled || !recoveryActive) {
							return;
						}
						recoveryTimer = undefined;
						setRecovery("stalled");
						diagnoseNow();
					}, SHAKA_RECOVERY_STALL_MS);
				};
				const onSegmentAppended = (event: Event) => {
					if (!recoveryActive) {
						return;
					}
					const { contentType, isMuxed } = event as Event & {
						contentType?: unknown;
						isMuxed?: unknown;
					};
					// A muxed append proves both tracks. For demuxed output, require every
					// media type in the active variant; audio alone must not hide dead video.
					if (isMuxed === true) {
						clearRecovery();
						return;
					}
					if (contentType !== "audio" && contentType !== "video") {
						return;
					}
					if (pendingMediaTypes === null) {
						clearRecovery();
						return;
					}
					pendingMediaTypes.delete(contentType);
					if (pendingMediaTypes.size === 0) {
						clearRecovery();
					}
				};
				const surfaceShakaError = (error: unknown) => {
					if (cancelled || errorSurfaced) {
						return;
					}
					loadPhase = "terminal";
					errorSurfaced = true;
					// Preserve an in-flight/completed stall diagnosis. diagnoseNow's guard
					// then issues one only when this episode had not reached the watchdog.
					stopRecovery();
					setWaiting(null);
					setPlaybackError(
						isMediaAccessDenied(error)
							? t("playback.accessDenied")
							: t("ui.playerFailedToLoad"),
					);
					diagnoseNow();
				};
				const onShakaError = (event: Event) => {
					if (cancelled || errorSurfaced) return;
					if (
						waitForFirstSegment &&
						isManifest404(event) &&
						(loadPhase === "loading" || loadPhase === "retry-wait") &&
						attempts < FIRST_SEGMENT_ATTEMPTS
					) {
						return;
					}
					// Shaka dispatches recoverable errors while it retries live manifest
					// updates and media segments. Keep the retry non-terminal but visible,
					// and require a successfully appended segment to prove recovery.
					if (isRecoverable(event)) {
						setRecoveryAccessDenied(isMediaAccessDenied(event));
						startRecovery();
						return;
					}
					surfaceShakaError(event);
				};
				const finishRetryWait = () => {
					if (retryTimer !== undefined) {
						clearTimeout(retryTimer);
						retryTimer = undefined;
					}
					const resolve = releaseRetry;
					releaseRetry = undefined;
					resolve?.();
				};
				const destroyOnce = () => {
					if (destroyed) {
						return;
					}
					destroyed = true;
					finishRetryWait();
					recoveryActive = false;
					stopRecoveryTimer();
					shakaPlayer.removeEventListener("error", onShakaError);
					shakaPlayer.removeEventListener("segmentappended", onSegmentAppended);
					void shakaPlayer.destroy();
				};
				// Set cleanup immediately: attach and load are both asynchronous.
				cleanup = destroyOnce;

				shakaPlayer.addEventListener("error", onShakaError);
				shakaPlayer.addEventListener("segmentappended", onSegmentAppended);
				await shakaPlayer.attach(video);
				if (cancelled) {
					destroyOnce();
					return;
				}
				// Shaka enables CMSD by default. Preview requests must not emit
				// CMCD or consume CMSD unless the operator explicitly asks for it.
				shakaPlayer.configure({
					cmcd: { enabled: false, eventTargets: [] },
					cmsd: { enabled: false },
				});

				while (!cancelled) {
					try {
						loadPhase = "loading";
						await shakaPlayer.load(url, null, "application/dash+xml");
						if (!errorSurfaced) {
							loadPhase = "loaded";
						}
						if (!cancelled) {
							sourceAttached = true;
							onMetadata();
							clearRecovery();
							setWaiting(null);
						}
						break;
					} catch (error) {
						if (cancelled) {
							break;
						}
						if (
							waitForFirstSegment &&
							!errorSurfaced &&
							isManifest404(error) &&
							attempts < FIRST_SEGMENT_ATTEMPTS
						) {
							attempts += 1;
							loadPhase = "retry-wait";
							setWaiting(attempts);
							await new Promise<void>((resolve) => {
								releaseRetry = resolve;
								retryTimer = setTimeout(
									finishRetryWait,
									FIRST_SEGMENT_RETRY_MS,
								);
							});
							continue;
						}
						surfaceShakaError(error);
						break;
					}
				}
				if (cancelled) {
					destroyOnce();
				}
			}
		})().catch((err) => {
			if (cancelled) {
				return;
			}
			setPlaybackError(
				err instanceof Error ? err.message : t("ui.playerFailedToLoad"),
			);
			diagnoseNow();
		});

		return () => {
			cancelled = true;
			unbindSeek();
			video.removeEventListener("loadedmetadata", onMetadata);
			cleanup();
		};
		// `t` is in the list because the effect's error path formats copy with it;
		// it is stable per locale, so this does not re-run the player on every render.
	}, [
		url,
		kind,
		t,
		diagnoseNow,
		clearDiagnosis,
		video,
		waitForFirstSegment,
		useBitmovin,
		bindSeek,
	]);

	const diagnosis =
		cors && cors !== "failed" && kind !== "MP4"
			? playbackCorsMessage(cors, {
					kind,
					provider: useBitmovin ? "bitmovin" : "open-source",
				})
			: null;

	return (
		<>
			{playbackError ? (
				<div className="mb-2 space-y-2">
					<p role="alert" className="text-red-400 text-sm">
						{playbackError}
					</p>
					{url && kind ? (
						<Button
							type="button"
							variant="secondary"
							size="sm"
							onClick={onRetry}
						>
							{t("playback.retry")}
						</Button>
					) : null}
				</div>
			) : null}
			{waiting !== null && !playbackError ? (
				<p role="status" className="mb-2 text-amber-400 text-sm">
					{t("playback.waitingForFirstSegment", { attempt: String(waiting) })}
				</p>
			) : null}
			{recovery && waiting === null && !playbackError ? (
				<p role="status" className="mb-2 text-amber-400 text-sm">
					{recoveryAccessDenied ? `${t("playback.accessDenied")} ` : null}
					{t(
						recovery === "stalled"
							? "playback.recoveryStalled"
							: "playback.recovering",
					)}
				</p>
			) : null}
			{cors === "failed" ? (
				<p className="mb-2 text-xs text-zinc-500">
					{t("playback.corsCheckFailed")}
				</p>
			) : null}
			{diagnosis ? (
				<div className="mb-2 rounded-md border border-zinc-800 px-3 py-2">
					<p className="text-xs text-zinc-400">
						{t("playback.corsCheckTitle")}
					</p>
					<p
						className={`mt-1 text-xs ${
							diagnosis.implicated ? "text-amber-400" : "text-zinc-500"
						}`}
					>
						{t(diagnosis.key, diagnosis.values)}
					</p>
				</div>
			) : null}
			{/* No <track>: subtitles are a property of the encoding under test —
			 * a caption here would be one this app invented. (The former
			 * useMediaCaption suppression no longer suppresses anything —
			    biome 2.4 stopped flagging this shape;  sweep.) */}
			{sceneAnalysis?.scenes.length ? (
				<label className="mb-2 flex items-center gap-2 text-xs text-zinc-400">
					<input
						type="checkbox"
						checked={showScenes}
						onChange={(event) => setShowScenes(event.target.checked)}
					/>
					{t("library.sceneOverlay")}
				</label>
			) : null}
			{hasSubjects && (
				<div className="mb-2 text-xs text-zinc-400">
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={showSubjects}
							onChange={(event) => setShowSubjects(event.target.checked)}
						/>
						{t("library.subjectOverlay")}
					</label>
					{showSubjects && (
						<p className="mt-1">{t("library.subjectOverlayHint")}</p>
					)}
				</div>
			)}
			<div className="relative" ref={setOverlayHost}>
				{useBitmovin ? (
					<div
						ref={setContainer}
						data-testid="bitmovin-player-container"
						className="aspect-video w-full overflow-hidden rounded-md border border-zinc-800 bg-black"
					/>
				) : (
					<video
						ref={setVideo}
						onTimeUpdate={(event) => updateMediaTime(event.currentTarget)}
						onLoadedData={(event) => updateMediaTime(event.currentTarget)}
						onSeeked={(event) => updateMediaTime(event.currentTarget)}
						onEmptied={() => setMediaTime(null)}
						controls
						{...(autoPlay ? { autoPlay: true } : {})}
						muted
						playsInline
						className="aspect-video w-full rounded-md border border-zinc-800 bg-black"
					/>
				)}
				{activeScene ? (
					<div
						className="pointer-events-none absolute inset-x-2 top-2 rounded bg-black/80 px-2 py-1 text-xs text-zinc-100"
						data-testid="scene-overlay"
					>
						<p className="line-clamp-1 break-words font-medium">
							{activeScene.title || activeScene.type || activeScene.id}
						</p>
						{activeScene.summary ? (
							<p className="line-clamp-2 break-words">{activeScene.summary}</p>
						) : null}
					</div>
				) : null}
				{showSubjects && sceneAnalysis && (
					<SubjectOverlay
						host={overlayHost}
						analysis={sceneAnalysis}
						time={playbackError ? null : mediaTime}
					/>
				)}
			</div>
		</>
	);
}
