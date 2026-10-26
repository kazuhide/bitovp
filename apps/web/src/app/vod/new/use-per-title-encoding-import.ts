"use client";

import type { PerTitleCodec } from "@bitovp/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "@/lib/api";
import type { PerTitleEncodingImportResponse } from "./per-title-encoding-import";
import { validateEncodingImport } from "./per-title-encoding-import-client";

export type EncodingImportRequest = { encodingId: string } & (
	| { bitmovinAccountId: string; apiKey?: never; tenantOrgId?: never }
	| { apiKey: string; tenantOrgId?: string; bitmovinAccountId?: never }
);

export function usePerTitleEncodingImport(
	context: unknown,
	allowedCodecs: readonly PerTitleCodec[],
) {
	const [result, setResult] = useState<{
		value: PerTitleEncodingImportResponse;
		context: unknown;
		generation: number;
	} | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<
		"failed" | "forbidden" | "changed" | "invalidResponse" | null
	>(null);
	const pending = useRef<AbortController | null>(null);
	const generation = useRef(0);
	const started = useRef(false);
	const currentContext = useRef(context);
	currentContext.current = context;
	const previousContext = useRef(context);
	const invalidate = useCallback(() => {
		generation.current += 1;
		pending.current?.abort();
		pending.current = null;
		started.current = false;
		setResult(null);
		setLoading(false);
		setError(null);
	}, []);
	useEffect(() => {
		if (previousContext.current !== context) {
			previousContext.current = context;
			const changed = started.current;
			invalidate();
			if (changed) setError("changed");
		}
	}, [context, invalidate]);
	useEffect(
		() => () => {
			generation.current += 1;
			pending.current?.abort();
		},
		[],
	);
	async function fetchSettings(body: EncodingImportRequest) {
		invalidate();
		started.current = true;
		const captured = generation.current;
		const controller = new AbortController();
		pending.current = controller;
		setLoading(true);
		const current = () =>
			generation.current === captured &&
			pending.current === controller &&
			currentContext.current === context;
		try {
			const raw = await apiFetch<unknown>(
				"/api/per-title-simulator/encodings/import",
				{
					method: "POST",
					body: JSON.stringify(body),
					cache: "no-store",
					signal: controller.signal,
				},
			);
			if (!current()) return;
			try {
				setResult({
					value: validateEncodingImport(raw, allowedCodecs),
					context,
					generation: captured,
				});
			} catch {
				setError("invalidResponse");
			}
		} catch (failure) {
			if (current())
				setError(
					failure instanceof ApiError && failure.status === 403
						? "forbidden"
						: "failed",
				);
		} finally {
			if (current()) {
				pending.current = null;
				setLoading(false);
			}
		}
	}
	const validResult =
		result &&
		result.context === context &&
		result.generation === generation.current
			? result.value
			: null;
	return {
		result: validResult,
		resultVersion: result?.generation,
		loading,
		error,
		invalidate,
		fetchSettings,
	};
}
