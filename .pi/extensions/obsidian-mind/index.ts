/**
 * obsidian-mind for pi — resource bridge.
 *
 * Bridges the vault's existing `.claude/skills/` directory into pi's skill
 * discovery so the same skill files serve both harnesses (obsidian-mind's
 * "agent-agnostic core" principle). No duplication: pi reads the originals
 * in place; Claude Code, Codex and Gemini are unaffected.
 *
 * More lifecycle ports (briefing injection, write validation, QMD tools)
 * land in later phases of the pi port; see PORTING-PLAN.md at repo root
 * of the development workspace.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("resources_discover", async (event, _ctx) => {
		const skillsDir = join(event.cwd, ".claude", "skills");
		if (!existsSync(skillsDir)) return;
		return { skillPaths: [skillsDir] };
	});
}
