export const CURSOR_PI_BRIDGE_MCP_TOOL_PREFIX = "";
export const CURSOR_PI_BRIDGE_PREFERENCE_TEXT =
	"Tools: call available tools directly by their declared name; execute actions through the host environment.";

const CURSOR_PI_BRIDGE_CONTRACT_LINES = [
	"Pi bridge contract:",
	"Exposed tools are live host tools available for this run.",
	"Call tools directly by their declared name.",
	CURSOR_PI_BRIDGE_PREFERENCE_TEXT,
	"Calls execute through normal pi tool flow and return normal tool results.",
] as const;

export function getCursorPiBridgeContractText(): string {
	return CURSOR_PI_BRIDGE_CONTRACT_LINES.join("\n");
}

function formatPromptGuidelines(promptGuidelines: readonly string[] | undefined): string | undefined {
	const guidelines = promptGuidelines?.map((guideline) => guideline.trim()).filter(Boolean) ?? [];
	if (guidelines.length === 0) return undefined;
	return ["Pi tool prompt guidelines:", ...guidelines.map((guideline) => `- ${guideline}`)].join("\n");
}

export function buildCursorPiBridgeMcpToolDescription(options: {
	piToolName: string;
	mcpToolName: string;
	piToolDescription: string;
	piToolPromptGuidelines?: readonly string[];
}): string {
	const lines = [
		options.piToolDescription,
		formatPromptGuidelines(options.piToolPromptGuidelines),
		`Call tool name ${options.mcpToolName}. Full tool-surface rules are in the session bootstrap prompt.`,
	];
	return lines.filter((line): line is string => line !== undefined).join("\n");
}
