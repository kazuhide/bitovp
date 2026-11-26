"use client";

import { useMutation } from "@tanstack/react-query";

type WizardSubmission<T> = {
	send: () => Promise<T>;
	finishDraft?: () => Promise<void>;
};

/** Capture both the request and its draft on click, including submissions paused offline. */
export function useWizardSubmission<T>(
	prepare: () => () => Promise<T>,
	afterSubmission: () => (() => Promise<void>) | undefined,
	onSuccess: (result: T) => void,
) {
	const mutation = useMutation({
		mutationFn: (submission: WizardSubmission<T>) => submission.send(),
		async onSuccess(result, submission) {
			await submission.finishDraft?.();
			onSuccess(result);
		},
	});
	return {
		...mutation,
		mutate() {
			let send: () => Promise<T>;
			try {
				send = prepare();
			} catch (error) {
				send = () => Promise.reject(error);
			}
			mutation.mutate({ send, finishDraft: afterSubmission() });
		},
	};
}
