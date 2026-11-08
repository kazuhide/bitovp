"use client";

import { z } from "zod";
import { useDocumentOrganization } from "@/components/providers";
import { useSession } from "@/lib/auth/use-session";

const DEFAULT_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";

/** Fence a multi-request editing action to the observed actor and organization. */
export function useEditingActor(): string | null {
	const organizationId = useDocumentOrganization();
	const session = useSession();
	const value = session.status === "success" ? session.data : undefined;
	const singleOrganization =
		value?.mode === "none" || value?.mode === "password";
	// These successful legacy sessions omit the org, but only own the default org.
	const resolvedOrganizationId =
		value?.organizationId === undefined && singleOrganization
			? DEFAULT_ORGANIZATION_ID
			: value?.organizationId;
	if (
		!value?.configured ||
		!value.authenticated ||
		value.organizationUnavailable ||
		value.isImpersonating ||
		!z.uuid().safeParse(resolvedOrganizationId).success ||
		(singleOrganization &&
			resolvedOrganizationId !== DEFAULT_ORGANIZATION_ID) ||
		(organizationId && resolvedOrganizationId !== organizationId) ||
		(value.mode === "users" &&
			(!z.uuid().safeParse(value.actorUserId).success ||
				!z.uuid().safeParse(value.effectiveUserId).success))
	)
		return null;
	return JSON.stringify([
		value.mode,
		resolvedOrganizationId,
		value.mode === "users" ? value.actorUserId : null,
		value.mode === "users" ? value.effectiveUserId : null,
	]);
}
