import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";

const lifecycle: string[] = [];

function UnmountTimerProbe() {
	useEffect(() => {
		const owner = document.createElement("div");
		owner.addEventListener("focusScope.autoFocusOnUnmount", () => {
			lifecycle.push("native-event");
		});
		return () => {
			lifecycle.push("unmount");
			setTimeout(() => {
				owner.dispatchEvent(new CustomEvent("focusScope.autoFocusOnUnmount"));
			}, 0);
		};
	}, []);
	return <div>Unmount timer probe</div>;
}

// These two lifecycle stages deliberately share a suite: the next test must
// start only after the previous component's unmount work finished in its realm.
describe.sequential("shared DOM teardown owns unmount timers", () => {
	it("mounts a component whose cleanup schedules a native DOM event", () => {
		render(<UnmountTimerProbe />);
		expect(screen.getByText("Unmount timer probe")).toBeInTheDocument();
		expect(lifecycle).toEqual([]);
	});
	it("finishes that native event before the next test or realm teardown", () => {
		expect(lifecycle).toEqual(["unmount", "native-event"]);
		expect(screen.queryByText("Unmount timer probe")).not.toBeInTheDocument();
	});
});
