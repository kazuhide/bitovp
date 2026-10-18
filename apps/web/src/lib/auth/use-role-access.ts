"use client";

import type { UserRole } from "@bitovp/db";
import type { ReactNode } from "react";
import { canAccess } from "./audience";
import { type MutationControlId, mutationControl } from "./mutation-controls";
import { useRoleView } from "./use-session";

/**
 * Client-side visibility for a panel or action whose API floor is above the
 * page's read floor. The proxy remains the control; this keeps a VIEWER from
 * being offered an operation that can only end in 403. Unresolved users-mode
 * sessions fail closed, while password/none deployments retain their
 * single-owner behaviour.
 */
export function useRoleAccess(minRole: UserRole): boolean {
	const { view } = useRoleView();
	return canAccess({ audience: "customer", minRole }, view);
}

export function useMutationAccess(control: MutationControlId): boolean {
	return useRoleAccess(mutationControl(control).minRole);
}

export function RoleAccess({
	control,
	children,
}: {
	control: MutationControlId;
	children: ReactNode;
}) {
	return useMutationAccess(control) ? children : null;
}
