export type VerificationCreateKind = "VOD_JOB" | "LIVE_CHANNEL";

export type PostCreateResponseLossCanaryState = {
	readonly scenario: string;
	createPosts: number;
	successfulCreates: number;
	injected: boolean;
	resourceKind?: VerificationCreateKind;
	createdLocalId?: string;
	adoptedLocalId?: string;
};

export type PostCreateResponseLossEvidence = {
	type: "PRODUCT_HTTP_CREATE_RESPONSE_LOSS";
	boundary: "VERIFICATION_CLIENT_TO_PRODUCT_API";
	trigger: "AFTER_SUCCESSFUL_FRESH_PRODUCT_HTTP_CREATE";
	/** This canary does not run inside the Bitmovin SDK/provider call boundary. */
	providerSdkResponseLossProven: false;
	scenario: string;
	resourceKind: VerificationCreateKind | null;
	createPosts: number;
	successfulCreates: number;
	injected: boolean;
	createdLocalId: string | null;
	adoptedLocalId: string | null;
	exactAdoption: boolean;
};

export function validatePostCreateResponseLossCanary(input: {
	enabled?: boolean;
	only?: readonly string[];
	maxSubmits?: number;
	dryRun?: boolean;
	resumeFrom?: string;
}): void {
	if (!input.enabled) return;
	if (input.only?.length !== 1 || input.only[0]?.trim() === "") {
		throw new Error(
			"--inject-post-create-response-loss requires exactly one --only scenario",
		);
	}
	if (input.maxSubmits !== 1) {
		throw new Error(
			"--inject-post-create-response-loss requires --max-submits 1",
		);
	}
	if (input.dryRun) {
		throw new Error(
			"--inject-post-create-response-loss must run without --dry-run",
		);
	}
	if (input.resumeFrom) {
		throw new Error(
			"--inject-post-create-response-loss must run without --resume-from so a fresh CREATE is exercised",
		);
	}
}

export function createPostCreateResponseLossCanary(
	scenario: string,
): PostCreateResponseLossCanaryState {
	return {
		scenario,
		createPosts: 0,
		successfulCreates: 0,
		injected: false,
	};
}

/** Call immediately before the one product CREATE POST. Throws before a second send. */
export function noteCanaryCreatePost(
	state: PostCreateResponseLossCanaryState | undefined,
	resourceKind: VerificationCreateKind,
	scenario: string,
): void {
	if (!state) return;
	if (scenario !== state.scenario) {
		throw new Error(
			`post-CREATE response-loss canary armed for ${state.scenario}, not ${scenario}`,
		);
	}
	if (state.createPosts !== 0) {
		throw new Error(
			"post-CREATE response-loss canary refused a second CREATE POST",
		);
	}
	state.createPosts = 1;
	state.resourceKind = resourceKind;
}

/**
 * Discard a response only after the product returned a fresh success with an id.
 * A replay is an adoption result, not a CREATE, and therefore cannot satisfy this canary.
 */
export function shouldInjectPostCreateResponseLoss(
	state: PostCreateResponseLossCanaryState | undefined,
	input: {
		resourceKind: VerificationCreateKind;
		scenario: string;
		localId: string;
		replayed: boolean;
	},
): boolean {
	if (
		!state ||
		state.injected ||
		input.replayed ||
		input.scenario !== state.scenario ||
		state.createPosts !== 1 ||
		state.resourceKind !== input.resourceKind
	) {
		return false;
	}
	state.successfulCreates = 1;
	state.injected = true;
	state.createdLocalId = input.localId;
	return true;
}

export function noteCanaryAdoption(
	state: PostCreateResponseLossCanaryState | undefined,
	localId: string,
): void {
	if (!state?.injected) return;
	state.adoptedLocalId = localId;
}

export function canaryCompletionError(
	state: PostCreateResponseLossCanaryState,
): string | undefined {
	if (
		state.createPosts !== 1 ||
		state.successfulCreates !== 1 ||
		!state.injected ||
		!state.createdLocalId
	) {
		return "the selected scenario did not reach one fresh successful product HTTP CREATE, so response loss was not injected";
	}
	if (!state.adoptedLocalId) {
		return "the product-HTTP-response-lost resource was not adopted through its durable intent";
	}
	if (state.adoptedLocalId !== state.createdLocalId) {
		return `intent adoption returned ${state.adoptedLocalId}, not the successfully created resource ${state.createdLocalId}`;
	}
	return undefined;
}

export function postCreateResponseLossEvidence(
	state: PostCreateResponseLossCanaryState,
): PostCreateResponseLossEvidence {
	return {
		type: "PRODUCT_HTTP_CREATE_RESPONSE_LOSS",
		boundary: "VERIFICATION_CLIENT_TO_PRODUCT_API",
		trigger: "AFTER_SUCCESSFUL_FRESH_PRODUCT_HTTP_CREATE",
		providerSdkResponseLossProven: false,
		scenario: state.scenario,
		resourceKind: state.resourceKind ?? null,
		createPosts: state.createPosts,
		successfulCreates: state.successfulCreates,
		injected: state.injected,
		createdLocalId: state.createdLocalId ?? null,
		adoptedLocalId: state.adoptedLocalId ?? null,
		exactAdoption:
			state.createdLocalId !== undefined &&
			state.adoptedLocalId === state.createdLocalId,
	};
}
