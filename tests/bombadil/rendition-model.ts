export type RenditionObservation = {
	pristine: boolean;
	selected: string | null;
	rows: { label: string }[];
	intent: { label: string | null } | null;
	receipts: {
		valid: boolean;
		actual: string | null;
		expected: string | null;
	}[];
	addClicks: number;
};

// The same predicates run in Bombadil and against its retained observations.
// Expected values originate in fixture inputs and captured visible user intent.
export const renditionInvariants = {
	defaultCopySourceIsLast: (state: RenditionObservation | null) =>
		!state?.pristine || state.selected === state.rows.at(-1)?.label,
	explicitSelectionIsNotRedirected: (state: RenditionObservation | null) =>
		!state?.intent || state.selected === state.intent.label,
	copiedSourceMatchesVisibleChoice: (state: RenditionObservation | null) =>
		!state ||
		state.receipts.every(
			(receipt) => receipt.valid && receipt.actual === receipt.expected,
		),
	eachAddHasOneReceipt: (state: RenditionObservation | null) =>
		!state || state.receipts.length === state.addClicks,
};
