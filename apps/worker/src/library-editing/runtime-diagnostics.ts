import {
	type LocalSemanticConfiguration,
	type LocalSemanticDiagnosticRequest,
	type LocalSemanticDiagnosticResult,
	type LocalStoryChoiceDiagnosticRequest,
	type LocalStoryChoiceDiagnosticResult,
	type LocalStoryFlowDiagnosticResult,
	localSemanticConnectionHash,
	localSemanticDiagnosticKeys,
	localSemanticDiagnosticRequestSchema,
	localSemanticDiagnosticResultSchema,
	localStoryChoiceDiagnosticKeys,
	localStoryChoiceDiagnosticRequestSchema,
	localStoryChoiceDiagnosticResultSchema,
	localStoryFlowDiagnosticKeys,
	localStoryFlowOperatorGate,
	localStoryFlowWorkerHeartbeatSchema,
	parseLocalStoryFlowDiagnosticRequest,
	parseLocalStoryFlowDiagnosticResult,
	readLocalSemanticConfiguration,
} from "@bitovp/core";
import type { LocalCaptionTranslationSelection } from "@bitovp/core/local-caption-config";
import {
	probeLocalSemanticGateway,
	probeLocalStoryChoiceGateway,
	probeLocalStoryFlowGateway,
} from "@bitovp/core/local-semantic-diagnostic-probe";

type Keys = ReturnType<typeof localSemanticDiagnosticKeys>;
export async function startLocalSemanticDiagnostics(input: {
	env: Record<string, string | undefined>;
	captionModelHash?: string;
	captionSelection?: LocalCaptionTranslationSelection;
	claim(keys: Keys): Promise<string | null>;
	publish(keys: Keys, result: LocalSemanticDiagnosticResult): Promise<unknown>;
	probe?: (
		config: LocalSemanticConfiguration,
		signal: AbortSignal,
	) => Promise<LocalSemanticDiagnosticResult["diagnostic"]>;
}) {
	let config: ReturnType<typeof readLocalSemanticConfiguration>;
	try {
		config = readLocalSemanticConfiguration(input.env);
	} catch {
		/* No valid connection identity. */
	}
	if (!config) return { stop: async () => {} };
	const connectionHash = await localSemanticConnectionHash(
		config,
		input.captionModelHash,
	);
	const configured = config;
	const keys = localSemanticDiagnosticKeys(connectionHash);
	const shutdown = new AbortController();
	let stopped = false;
	let pending: Promise<unknown> | undefined;
	const tick = () => {
		if (stopped || pending) return;
		pending = (async () => {
			const raw = await input.claim(keys);
			if (!raw || raw.length > 512 || stopped) return;
			let request: LocalSemanticDiagnosticRequest;
			try {
				request = localSemanticDiagnosticRequestSchema.parse(JSON.parse(raw));
			} catch {
				return;
			}
			const now = Date.now();
			if (request.expiresAt <= now || request.expiresAt > now + 45_000) return;
			const signal = AbortSignal.any([
				shutdown.signal,
				AbortSignal.timeout(request.expiresAt - now),
			]);
			const diagnostic = await (
				input.probe ??
				((configuration, abort) =>
					probeLocalSemanticGateway(
						configuration,
						undefined,
						abort,
						input.captionSelection,
					))
			)(configured, signal);
			if (stopped || signal.aborted) return;
			const result = localSemanticDiagnosticResultSchema.parse({
				version: "local-semantic-diagnostic-result-v1",
				requestId: request.requestId,
				connectionHash,
				profile: configured.profile,
				observedAt: Date.now(),
				diagnostic,
			});
			await input.publish(keys, result);
		})()
			.catch(() => undefined)
			.finally(() => {
				pending = undefined;
			});
	};
	const interval = setInterval(tick, 1_000);
	interval.unref();
	return {
		stop: async () => {
			stopped = true;
			clearInterval(interval);
			shutdown.abort();
			if (!pending) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					pending,
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, 1_000);
						timer.unref();
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
	};
}

/** Choice uses its own capability channel and never upgrades an old worker report. */
export async function startLocalStoryChoiceDiagnostics(input: {
	env: Record<string, string | undefined>;
	initialized: boolean;
	captionModelHash?: string;
	captionSelection?: LocalCaptionTranslationSelection;
	claim(
		keys: ReturnType<typeof localStoryChoiceDiagnosticKeys>,
	): Promise<string | null>;
	publish(
		keys: ReturnType<typeof localStoryChoiceDiagnosticKeys>,
		result: LocalStoryChoiceDiagnosticResult,
	): Promise<unknown>;
	probe?: (
		config: LocalSemanticConfiguration,
		signal: AbortSignal,
	) => Promise<LocalStoryChoiceDiagnosticResult["diagnostic"]>;
}) {
	if (!input.initialized || input.env.BITOVP_LOCAL_STORY_CHOICE_ENABLED !== "1")
		return { stop: async () => {} };
	let config: ReturnType<typeof readLocalSemanticConfiguration>;
	try {
		config = readLocalSemanticConfiguration(input.env);
	} catch {
		/* Invalid configuration cannot advertise capability. */
	}
	if (!config) return { stop: async () => {} };
	const configured = config;
	const connectionHash = await localSemanticConnectionHash(
		config,
		input.captionModelHash,
	);
	const keys = localStoryChoiceDiagnosticKeys(connectionHash);
	const shutdown = new AbortController();
	let stopped = false;
	let pending: Promise<unknown> | undefined;
	const tick = () => {
		if (stopped || pending) return;
		pending = (async () => {
			const raw = await input.claim(keys);
			if (!raw || raw.length > 512 || stopped) return;
			let request: LocalStoryChoiceDiagnosticRequest;
			try {
				request = localStoryChoiceDiagnosticRequestSchema.parse(
					JSON.parse(raw),
				);
			} catch {
				return;
			}
			const now = Date.now();
			if (request.expiresAt <= now || request.expiresAt > now + 45_000) return;
			const signal = AbortSignal.any([
				shutdown.signal,
				AbortSignal.timeout(request.expiresAt - now),
			]);
			const diagnostic = await (
				input.probe ??
				((configuration, abort) =>
					probeLocalStoryChoiceGateway(
						configuration,
						undefined,
						abort,
						input.captionSelection,
					))
			)(configured, signal);
			if (stopped || signal.aborted) return;
			await input.publish(
				keys,
				localStoryChoiceDiagnosticResultSchema.parse({
					version: "local-story-choice-diagnostic-result-v1",
					requestId: request.requestId,
					connectionHash,
					profile: configured.profile,
					observedAt: Date.now(),
					diagnostic,
				}),
			);
		})()
			.catch(() => undefined)
			.finally(() => {
				pending = undefined;
			});
	};
	const interval = setInterval(tick, 1_000);
	interval.unref();
	return {
		stop: async () => {
			stopped = true;
			clearInterval(interval);
			shutdown.abort();
			if (!pending) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					pending,
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, 1_000);
						timer.unref();
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
	};
}

/** A separate channel; trusted bootstrap must supply a real initialized FLOW capability. */
export async function startLocalStoryFlowDiagnostics(input: {
	env: Record<string, string | undefined>;
	initialized: boolean;
	instanceId: string;
	capabilityHash: string;
	captionModelHash?: string;
	captionSelection?: LocalCaptionTranslationSelection;
	claim(
		keys: ReturnType<typeof localStoryFlowDiagnosticKeys>,
	): Promise<string | null>;
	publish(
		keys: ReturnType<typeof localStoryFlowDiagnosticKeys>,
		result: LocalStoryFlowDiagnosticResult,
	): Promise<unknown>;
	probe?: (
		config: LocalSemanticConfiguration,
		signal: AbortSignal,
	) => Promise<LocalSemanticDiagnosticResult["diagnostic"]>;
}) {
	if (
		!input.initialized ||
		localStoryFlowOperatorGate(input.env.BITOVP_LOCAL_STORY_FLOW_ENABLED) !==
			"ENABLED"
	)
		return { stop: async () => {} };
	const { instanceId, capabilityHash, captionSelection } = input;
	let configured: LocalSemanticConfiguration;
	let connectionHash: string;
	let keys: ReturnType<typeof localStoryFlowDiagnosticKeys>;
	try {
		const config = readLocalSemanticConfiguration(input.env);
		if (
			!config ||
			!localStoryFlowWorkerHeartbeatSchema.shape.instanceId.safeParse(
				instanceId,
			).success
		)
			return { stop: async () => {} };
		configured = config;
		connectionHash = await localSemanticConnectionHash(
			config,
			input.captionModelHash,
		);
		keys = localStoryFlowDiagnosticKeys(connectionHash, capabilityHash);
	} catch {
		return { stop: async () => {} };
	}
	const shutdown = new AbortController();
	let stopped = false;
	let pending: Promise<unknown> | undefined;
	const tick = () => {
		if (stopped || pending) return;
		pending = (async () => {
			const raw = await input.claim(keys);
			if (stopped || raw === null) return;
			const notBefore = Date.now();
			const request = parseLocalStoryFlowDiagnosticRequest(raw, {
				capabilityHash,
				now: notBefore,
			});
			const signal = AbortSignal.any([
				shutdown.signal,
				AbortSignal.timeout(request.expiresAt - notBefore),
			]);
			const diagnostic = await (
				input.probe ??
				((configuration, abort) =>
					probeLocalStoryFlowGateway(
						configuration,
						undefined,
						abort,
						captionSelection,
					))
			)(configured, signal);
			if (stopped || signal.aborted) return;
			const now = Date.now();
			const result = parseLocalStoryFlowDiagnosticResult(
				JSON.stringify({
					version: "local-story-flow-diagnostic-result-v1",
					requestId: request.requestId,
					connectionHash,
					capabilityHash,
					instanceId,
					profile: configured.profile,
					observedAt: now,
					diagnostic,
				}),
				{
					requestId: request.requestId,
					connectionHash,
					capabilityHash,
					instanceId,
					profile: configured.profile,
					now,
					notBefore,
					notAfter: request.expiresAt,
				},
			);
			await input.publish(keys, result);
		})()
			.catch(() => undefined)
			.finally(() => {
				pending = undefined;
			});
	};
	const interval = setInterval(tick, 1_000);
	interval.unref();
	return {
		stop: async () => {
			if (stopped) return;
			stopped = true;
			clearInterval(interval);
			shutdown.abort();
			if (!pending) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					pending,
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, 1_000);
						timer.unref();
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
	};
}
