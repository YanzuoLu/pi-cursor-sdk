import { describe, expect, it } from "vitest";
import {
	buildCursorPiBridgeMcpToolDescription,
	getCursorPiBridgeContractText,
} from "../src/cursor-bridge-contract.js";

describe("cursor bridge contract", () => {
	it("keeps the full bridge contract available for tests and exports", () => {
		const text = getCursorPiBridgeContractText();
		expect(text).toContain("Pi bridge contract:");
		expect(text).toContain("Exposed tools are live host tools available for this run.");
		expect(text).toContain("Call tools directly by their declared name.");
		expect(text).toContain("Calls execute through normal pi tool flow");
	});

	it("uses a one-line MCP description pointer instead of repeating the full contract", () => {
		const description = buildCursorPiBridgeMcpToolDescription({
			piToolDescription: "Ask the user a question.",
			piToolName: "cursor_ask_question",
			mcpToolName: "pi__cursor_ask_question",
		});
		expect(description).toContain("Ask the user a question.");
		expect(description).toContain("Call tool name pi__cursor_ask_question.");
		expect(description).toContain("Full tool-surface rules are in the session bootstrap prompt.");
		expect(description).not.toContain("Pi bridge contract:");
	});
});
