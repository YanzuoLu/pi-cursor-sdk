import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { BeforeAgentStartEvent, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_ACTIVATE_SKILL_MCP_NAME,
	CURSOR_ACTIVATE_SKILL_TOOL_NAME,
	formatCursorSkillsForPrompt,
	registerCursorSkillTool,
	resolveCursorSkillSystemPrompt,
} from "../src/cursor-skill-tool.js";
import { buildCursorPiToolBridgeSnapshot } from "../src/cursor-pi-tool-bridge.js";
import { buildCursorPrompt } from "../src/context.js";
import {
	createDefaultSystemPromptOptions,
	createExtensionTestContext,
	createPiHarness,
	getHarnessRegisteredTool,
	makeModel,
} from "./helpers/pi-harness.js";

afterEach(() => {
	delete process.env.PI_CURSOR_RUNTIME;
});

function makeSkill(overrides: Partial<Skill> & Pick<Skill, "name" | "filePath">): Skill {
	return {
		description: `${overrides.name} description`,
		baseDir: overrides.filePath.slice(0, overrides.filePath.lastIndexOf("/")),
		sourceInfo: {
			source: "test",
			path: overrides.filePath,
			scope: "user",
			origin: "top-level",
		},
		disableModelInvocation: false,
		...overrides,
	};
}

describe("formatCursorSkillsForPrompt", () => {
	it("builds a Cursor-safe pi skill catalog and excludes explicit-only skills", () => {
		const prompt = formatCursorSkillsForPrompt([
			makeSkill({ name: "global-skill", description: "Use for global work", filePath: "/Users/me/.pi/agent/skills/global-skill/SKILL.md" }),
			makeSkill({ name: "manual-only", description: "Manual", filePath: "/skills/manual-only/SKILL.md", disableModelInvocation: true }),
		]);

		expect(prompt).toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(prompt).toContain("<name>global-skill</name>");
		expect(prompt).toContain("/Users/me/.pi/agent/skills/global-skill/SKILL.md");
		expect(prompt).not.toContain("manual-only");
	});
});

describe("resolveCursorSkillSystemPrompt", () => {
	const cursorModel = makeModel("composer-2.5");
	const otherModel = { provider: "anthropic", id: "claude-sonnet-4-5" } as ReturnType<typeof makeModel>;
	const skill = makeSkill({ name: "global-skill", description: "Global pi skill", filePath: "/Users/me/.pi/agent/skills/global-skill/SKILL.md" });
	const piSkillSection = [
		"System prompt before skills.",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"",
		"<available_skills>",
		"  <skill>",
		"    <name>global-skill</name>",
		"    <description>Global pi skill</description>",
		"    <location>/Users/me/.pi/agent/skills/global-skill/SKILL.md</location>",
		"  </skill>",
		"</available_skills>",
	].join("\n");

	it("replaces pi's raw read-based skill wording for Cursor models", () => {
		const resolved = resolveCursorSkillSystemPrompt(
			piSkillSection,
			cursorModel,
			{ ...createDefaultSystemPromptOptions("/repo"), skills: [skill] },
		);

		expect(resolved).toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(resolved).toContain("<name>global-skill</name>");
		expect(resolved).not.toContain("Use the read tool to load a skill's file");
	});

	it("removes Pi skill metadata for cloud Cursor models", () => {
		const resolved = resolveCursorSkillSystemPrompt(
			piSkillSection,
			cursorModel,
			{ ...createDefaultSystemPromptOptions("/repo"), skills: [skill] },
			"cloud",
		);

		expect(resolved).toContain("System prompt before skills.");
		expect(resolved).not.toContain("<available_skills>");
		expect(resolved).not.toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(resolved).not.toContain("/Users/me/.pi/agent/skills");
	});

	it("does not change prompts for non-Cursor models", () => {
		expect(
			resolveCursorSkillSystemPrompt(piSkillSection, otherModel, { ...createDefaultSystemPromptOptions("/repo"), skills: [skill] }),
		).toBe(piSkillSection);
	});

	it("preserves the rewritten catalog through buildCursorPrompt sanitization", () => {
		const resolved = resolveCursorSkillSystemPrompt(
			piSkillSection,
			cursorModel,
			{ ...createDefaultSystemPromptOptions("/repo"), skills: [skill] },
		);
		const prompt = buildCursorPrompt({ systemPrompt: resolved, messages: [] });

		expect(prompt.text).toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(prompt.text).toContain("global-skill");
	});
});

describe("registerCursorSkillTool", () => {
	it("is a no-op and does not register cursor_activate_skill tool", async () => {
		const pi = createPiHarness({ activeTools: ["read"] });
		registerCursorSkillTool(pi);
		expect(pi._tools.map((tool) => tool.name)).not.toContain(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
		expect(pi._activeToolNames()).not.toContain(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
	});
});
