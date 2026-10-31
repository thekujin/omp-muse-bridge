import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fakeMuse, isolated, temporary, testCatalog } from "./helpers.ts";

/** Records each `muse serve` spawn's flags; answers model/list so the catalog probe runs against the same fake. */
const handler = `function onRequest(request) {
	if (request.method === "initialize") fs.appendFileSync(process.env.MUSE_SPAWN_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
	if (request.method !== "model/list") return false;
	reply(request, {models: [{modelId: "muse-test", displayLabel: "Muse test", isDefault: true, isActive: true}]});
	return true;
}`;

const imports = `
import assert from "node:assert/strict";
import { listMuseCatalog, runMuseTurn, shutdownHost } from "./src/msp.ts";
const turn = (sessionId, modelId, sandboxed = true) => ({ sessionId, resumeExisting: false, prompt: "test", modelId, workspace: process.env.TEST_DIR, sandboxed });
`;

async function spawnedArguments(directory: string): Promise<string[][]> {
	const log = await fs.readFile(path.join(directory, "spawns.log"), "utf8").catch(() => "");
	return log.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function environment(directory: string, data: string, executable: string): Record<string, string> {
	return { TEST_DIR: directory, XDG_DATA_HOME: data, PI_MUSE_BINARY: executable, MUSE_SPAWN_LOG: path.join(directory, "spawns.log") };
}

test("standard and contributor turns spawn separate hosts with matching --contributor-mode", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const executable = await fakeMuse(directory, handler);
	const result = await isolated(imports + `
		try {
			const standard = await runMuseTurn(turn("standard-session", "muse-test"));
			const contributor = await runMuseTurn(turn("contributor-session", "muse-test-contributor"));
			assert.equal(standard.errorMessage, undefined);
			assert.equal(contributor.errorMessage, undefined);
		} finally { shutdownHost(); }
	`, environment(directory, data, executable));
	expect(result.exitCode, result.stderr).toBe(0);
	expect(await spawnedArguments(directory)).toEqual([
		["serve", "--trust-workspace", "--contributor-mode", "off", "-c", 'run.subagent_delegation_mode="auto"'],
		["serve", "--trust-workspace", "--contributor-mode", "on", "-c", 'run.subagent_delegation_mode="auto"'],
	]);
}));

test("standard and contributor turns run simultaneously on separate hosts", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const executable = await fakeMuse(directory, handler);
	const result = await isolated(imports + `
		try {
			const [standard, contributor] = await Promise.all([
				runMuseTurn(turn("standard-session", "muse-test", false)),
				runMuseTurn(turn("contributor-session", "muse-test-contributor", false)),
			]);
			assert.equal(standard.output, "OK");
			assert.equal(contributor.output, "OK");
		} finally { shutdownHost(); }
	`, environment(directory, data, executable));
	expect(result.exitCode, result.stderr).toBe(0);
	expect((await spawnedArguments(directory)).map((args) => args.join(" ")).sort()).toEqual([
		"serve --disable-sandbox --trust-workspace --contributor-mode off -c run.subagent_delegation_mode=\"auto\"",
		"serve --disable-sandbox --trust-workspace --contributor-mode on -c run.subagent_delegation_mode=\"auto\"",
	]);
}));

test("the model catalog probe runs on a standard-mode host", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const executable = await fakeMuse(directory, handler);
	const result = await isolated(imports + `
		try {
			const catalog = await listMuseCatalog(true);
			assert.deepEqual(catalog.models.map((model) => model.id), ["muse-test"]);
		} finally { shutdownHost(); }
	`, environment(directory, data, executable));
	expect(result.exitCode, result.stderr).toBe(0);
	expect(await spawnedArguments(directory)).toEqual([["serve", "--trust-workspace", "--contributor-mode", "off", "-c", 'run.subagent_delegation_mode="auto"']]);
}));

test("a session cannot switch contributor modes and no host is spawned for the rejected turn", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const executable = await fakeMuse(directory, handler);
	const result = await isolated(imports + `
		try {
			const standard = await runMuseTurn(turn("mode-session", "muse-test"));
			assert.equal(standard.errorMessage, undefined);
			await assert.rejects(runMuseTurn(turn("mode-session", "muse-test-contributor")), /opened in standard mode/);
		} finally { shutdownHost(); }
	`, environment(directory, data, executable));
	expect(result.exitCode, result.stderr).toBe(0);
	expect(await spawnedArguments(directory)).toEqual([["serve", "--trust-workspace", "--contributor-mode", "off", "-c", 'run.subagent_delegation_mode="auto"']]);
}));
