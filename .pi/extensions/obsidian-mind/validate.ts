/**
 * Write validation — pi port of the PostToolUse hook.
 *
 * Mirrors `.claude/scripts/validate-write.ts`, importing the same lib
 * contracts (frontmatter validation, hygiene detectors, debounced QMD
 * refresh) rather than re-implementing them. The differences from the
 * Claude Code hook are structural only:
 *
 *   - runs inside pi's `tool_result` event (after write/edit executes)
 *     and RETURNS the warning text instead of writing a hook envelope
 *   - cwd arrives as a parameter
 *
 * The memory-location guard is kept: a pi user may still have Claude
 * Code's auto-memory directory on disk, and the violation warning
 * routes them back to brain/ topic notes either way.
 */
import { basename, isAbsolute, join, resolve as resolvePath } from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";
import {
	isBlockedMemoryPath,
	shouldSkipFile,
	validateContent,
} from "../../../.claude/scripts/lib/frontmatter.ts";
import {
	MONOLITH_BYTES,
	formatClusterHint,
	formatMonolithHint,
	isMonolithExempt,
	newNoteClusterCandidate,
} from "../../../.claude/scripts/lib/active-hygiene.ts";
import {
	triggerDebouncedRefresh,
} from "../../../.claude/scripts/lib/qmd-refresh.ts";

export const DEBOUNCE_MS = 30_000;

/**
 * Fire the shared debounced QMD refresh for a written path. Uses the same
 * sentinel + detached worker as the Claude Code hooks, so a burst of
 * writes across BOTH harnesses produces at most one worker per debounce
 * window (one debounce contract, no drift between surfaces).
 */
export function refreshQmdFor(root: string, filePath: string): void {
	const scriptDir = join(root, ".claude", "scripts");
	triggerDebouncedRefresh({
		sentinelPath: join(scriptDir, ".qmd-refresh-sentinel"),
		workerPath: resolvePath(scriptDir, "qmd-refresh-run.ts"),
		debounceMs: DEBOUNCE_MS,
		logPrefix: "pi-validate-write",
	});
}

/**
 * Validate a written file. Returns warning text to append to the tool
 * result, or null when the path is out of scope or clean. All the skip
 * ladders, containment, and detectors mirror the Claude Code hook.
 */
export function validateWrittenFile(
	root: string,
	filePath: string,
): string | null {
	// pi models may pass relative paths (Claude Code's Write tool always sent
	// absolute ones) — resolve against the vault root before any comparison.
	const abs = isAbsolute(filePath) ? filePath : resolvePath(root, filePath);
	const vaultRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
	const filePathFwd = abs.replaceAll("\\", "/");

	// Memory-location guard BEFORE the vault-root skip: the auto-memory
	// directory lives outside the vault and would otherwise be skipped.
	let resolvedPath = abs;
	try {
		resolvedPath = realpathSync(abs);
	} catch {
		/* unreadable/racing path — lexical check below still applies */
	}
	if (isBlockedMemoryPath(filePath) || isBlockedMemoryPath(resolvedPath)) {
		const file = basename(filePathFwd);
		return [
			`⚠️  Memory location violation: \`${file}\` was written to \`~/.claude/.../memory/\`.`,
			"",
			"This directory should contain only MEMORY.md (the auto-loaded index).",
			"All durable knowledge belongs in the vault under `brain/` topic notes:",
			"",
			"- Patterns/conventions → `brain/Patterns.md`",
			"- Things that bit before → `brain/Gotchas.md`",
			"- Architectural/workflow decisions → `brain/Key Decisions.md`",
			"- Recent context, relationships, tools → `brain/Memories.md`",
			"- New topic → new `brain/<Topic>.md` note + index in `brain/Memories.md`",
			"",
			`Migrate the content from \`${file}\` into the right brain note, then delete the file from \`~/.claude/\`.`,
			"`MEMORY.md` itself can keep an index pointer to the brain note(s).",
		].join("\n");
	}

	// Outside the vault → not a vault note, no validation. Boundary-safe.
	if (filePathFwd !== vaultRoot && !filePathFwd.startsWith(vaultRoot + "/")) {
		return null;
	}

	if (shouldSkipFile(abs)) return null;

	let content: string;
	try {
		content = readFileSync(abs, { encoding: "utf-8" });
	} catch {
		return null;
	}

	const warnings = validateContent(content);
	const blocks: string[] = [];
	const relPath = filePathFwd.startsWith(vaultRoot + "/")
		? filePathFwd.slice(vaultRoot.length + 1)
		: filePathFwd;

	if (warnings.length > 0) {
		const hintList = warnings.map((w) => `  - ${w}`).join("\n");
		const base = basename(filePathFwd);
		blocks.push(
			`Vault hygiene warnings for \`${base}\`:\n${hintList}\nFix these before moving on.`,
		);
	}

	// Write-time organization flags: oversized-note and ungrouped-cluster
	// detectors, isolated so one failing check can't kill its siblings.
	try {
		const size = statSync(abs).size;
		if (size >= MONOLITH_BYTES && !isMonolithExempt(basename(filePathFwd))) {
			blocks.push(formatMonolithHint(relPath, size));
		}
	} catch {
		/* monolith check failed — skipped */
	}
	try {
		const cluster = newNoteClusterCandidate(filePath, vaultRoot);
		if (cluster !== null) {
			blocks.push(formatClusterHint(cluster));
		}
	} catch {
		/* cluster check failed — skipped */
	}

	if (blocks.length === 0) return null;
	return blocks.join("\n\n");
}
