export const LOCAL_CAPTION_CONTEXT_POLICY = {
	version: "caption-scene-context-v1",
	maxCueBytes: 2000,
	maxContextBytes: 1400,
	maxDataBytes: 4500,
	selection: "CURRENT_SOURCE_SPANS_OR_ANCHOR_WHOLE_FIELDS",
	consistency: "EXACT_SOURCE_SAME_BOUND_CONTEXT",
	style: "CONCISE_FAITHFUL",
} as const;

// Translation-only experimental identity; never part of the Story receipt union.
export const PLAMO_CAPTION_TEMPLATE = {
	version: "plamo-pfml3-caption-v1",
	dataset: "<|plamo:tag|>dataset<|plamo:msg|>translation",
	context: "<|plamo:tag|>context<|plamo:msg|>",
	input: "<|plamo:tag|>input",
	output: "<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja",
	message: "<|plamo:msg|>",
	language: "<|plamo:key|>lang<|plamo:val|>",
	glossary: "<|plamo:tag|>glossary",
	term: "<|plamo:index|>",
	definition: "<|plamo:item|>",
	style: "<|plamo:key|>form<|plamo:val|>plain",
	stop: ["<|plamo:tag|>", "<|plamo:bos|>"],
} as const;

export const PLAMO_CAPTION_VALIDATION_POLICY = {
	version: "plamo-caption-validation-v1",
	output: "PLAIN_EXACT_SOURCE_ID",
	reservedTokens: "REJECT",
	sourceClock: "IMMUTABLE",
	maximumPromptBytes: 5632,
} as const;

// These exact digests are used by browser and server wire schemas.
// The core tests verify each against its canonical policy with Node SHA-256.
export const LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT: string =
	"3f635f2d95715b292bc559c9a2e6e92f3320cd85f248ad2642e157592a287913";
export const PLAMO_CAPTION_TEMPLATE_HASH: string =
	"c9e9cb64b08d20a27fd455a837478f9f8a00bf84be0aada69f8f8ed1d5edb51b";
export const PLAMO_CAPTION_VALIDATION_POLICY_FINGERPRINT: string =
	"f1770a01029cb8739c6cbbf1ab4a67ff2c212a46d751395ee3b9f8406c7dcd6c";
