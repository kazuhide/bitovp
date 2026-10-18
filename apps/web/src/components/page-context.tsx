"use client";

import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

/** Pages retain their controls and state while the shell places account context. */
export const PageContextSlot = createContext<HTMLElement | null>(null);

export function PageContext({ children }: { children: ReactNode }) {
	const slot = useContext(PageContextSlot);
	return slot ? createPortal(children, slot) : children;
}
