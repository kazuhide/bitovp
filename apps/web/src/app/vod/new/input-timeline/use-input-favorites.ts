"use client";
import {
	favoriteReferenceKey,
	type VodInputFavoriteCreate,
	type VodInputFavoriteWire,
	vodInputFavoritesResponseSchema,
} from "@bitovp/core/vod-input-timeline";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDocumentOrganization } from "@/components/providers";
import { apiFetch } from "@/lib/api";
import { favoriteErrorCode } from "./favorite-labels";

const endpoint = "/api/vod/input-favorites";
export function useInputFavorites(enabled: boolean) {
	const organization = useDocumentOrganization();
	const latestOrg = useRef(organization);
	latestOrg.current = organization;
	const [state, setState] = useState<{
		org?: string;
		items: VodInputFavoriteWire[];
		error: string | null;
		loaded: boolean;
	}>({ items: [], error: null, loaded: false });
	const [busy, setBusy] = useState(false);
	const load = useCallback(
		async (signal?: AbortSignal) => {
			if (!organization) throw new Error("FAVORITE_UNAVAILABLE");
			const response = vodInputFavoritesResponseSchema.parse(
				await apiFetch<unknown>(endpoint, {
					signal,
					headers: { "x-bitovp-expected-org": organization },
				}),
			);
			if (latestOrg.current !== organization || signal?.aborted)
				throw new Error("FAVORITE_UNAVAILABLE");
			setState({
				org: organization,
				items: response.favorites,
				loaded: true,
				error: null,
			});
			return response.favorites;
		},
		[organization],
	);
	const fail = useCallback(
		(error: unknown) => {
			if (latestOrg.current === organization)
				setState((old) => ({
					...old,
					org: organization,
					error: favoriteErrorCode(error),
				}));
		},
		[organization],
	);
	useEffect(() => {
		if (!enabled || !organization) return;
		const controller = new AbortController();
		void load(controller.signal).catch((error) => {
			if (!controller.signal.aborted) fail(error);
		});
		return () => controller.abort();
	}, [enabled, organization, load, fail]);
	async function mutate(
		path: string,
		method: "POST" | "DELETE",
		body?: VodInputFavoriteCreate,
	) {
		if (!organization) return false;
		setBusy(true);
		try {
			await apiFetch(path, {
				method,
				headers: { "x-bitovp-expected-org": organization },
				...(body ? { body: JSON.stringify(body) } : {}),
			});
			await load();
			return true;
		} catch (error) {
			fail(error);
			return false;
		} finally {
			setBusy(false);
		}
	}
	const items = state.org === organization ? state.items : [];
	return {
		items,
		busy,
		ready:
			enabled && !!organization && state.org === organization && state.loaded,
		error: state.org === organization ? state.error : null,
		add: (body: VodInputFavoriteCreate) => mutate(endpoint, "POST", body),
		remove: (id: string) => mutate(`${endpoint}/${id}`, "DELETE"),
		load,
		fail,
		has: (
			value: Pick<
				VodInputFavoriteCreate,
				"credentialId" | "bucket" | "objectKey"
			>,
		) =>
			items.some(
				(item) => favoriteReferenceKey(item) === favoriteReferenceKey(value),
			),
	};
}
export type InputFavoritesModel = ReturnType<typeof useInputFavorites>;
