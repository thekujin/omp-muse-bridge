import { expect, test } from "bun:test";
import * as path from "node:path";
import { fakeMuse, isolated, temporary, testCatalog } from "./helpers.ts";

const discovery = `
import {setAgentDir} from "@oh-my-pi/pi-utils";
import {discoverMuseModels} from "./src/provider.ts";
import {resolveMuseModelId, resolveMuseSelection} from "./src/catalog.ts";
import {shutdownHost} from "./src/msp.ts";
setAgentDir(process.env.TEST_DIR);
const outcome = await discoverMuseModels(false).then(
	models => ({models: models.map(model => model.id), resolved: resolveMuseModelId("muse-spark"), contributor: resolveMuseSelection("muse-spark-contributor")}),
	error => ({error: error.message}),
);
console.log(JSON.stringify(outcome));
await shutdownHost();
`;

const listing = `
const onRequest = request => {
	if (request.method !== "model/list") return false;
	reply(request, {providerId: "meta", profileId: "tbh", source: "providerCatalog", models: [
		{modelId: "muse-wonder-1.0", displayLabel: "muse-wonder-1.0", isActive: false, isDefault: true, contextLimit: 1007997, outputLimit: 128000, cost: {input: "2.5", output: "10", cached: "0.25", currency: "USD"}},
		{modelId: "muse-spark-1.3", displayLabel: "muse-spark-1.3", isActive: false, isDefault: false, contextLimit: 1007997, outputLimit: 128000, cost: null},
	]});
	return true;
};`;

const failing = `
const onRequest = request => {
	if (request.method !== "model/list") return false;
	send({id: request.id, error: {code: -32000, message: "not authenticated"}});
	return true;
};`;

function outcomeOf(stdout: string): unknown {
	return JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
}

test("picker and execution use Muse's live model/list when the local cache is absent", () => temporary(async (directory) => {
	const executable = await fakeMuse(directory, listing);
	const result = await isolated(discovery, {
		TEST_DIR: directory,
		XDG_DATA_HOME: path.join(directory, "no-cache"),
		PI_MUSE_BINARY: executable,
	});
	expect(result.exitCode, result.stderr).toBe(0);
	expect(outcomeOf(result.stdout)).toEqual({
		models: ["muse-spark", "muse-spark-contributor", "muse-wonder-1.0", "muse-wonder-1.0-contributor", "muse-spark-1.3", "muse-spark-1.3-contributor"],
		resolved: "muse-wonder-1.0",
		contributor: { modelId: "muse-wonder-1.0", contributor: true },
	});
}));

test("live model prices are passed through for API-equivalent cost", () => temporary(async (directory) => {
	const executable = await fakeMuse(directory, listing);
	const result = await isolated(`
		import {discoverMuseModels} from "./src/provider.ts";
		const models = await discoverMuseModels(false);
		console.log(JSON.stringify(models.find(model => model.id === "muse-wonder-1.0").cost));
	`, { TEST_DIR: directory, XDG_DATA_HOME: path.join(directory, "no-cache"), PI_MUSE_BINARY: executable });
	expect(result.exitCode, result.stderr).toBe(0);
	expect(outcomeOf(result.stdout)).toEqual({ input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 0 });
}));

test("a failed live listing with no cache reports the Muse error instead of invented models", () => temporary(async (directory) => {
	const executable = await fakeMuse(directory, failing);
	const result = await isolated(discovery, {
		TEST_DIR: directory,
		XDG_DATA_HOME: path.join(directory, "no-cache"),
		PI_MUSE_BINARY: executable,
	});
	expect(result.exitCode, result.stderr).toBe(0);
	expect(outcomeOf(result.stdout)).toEqual({ error: "muse serve model/list failed: not authenticated" });
}));

test("a failed live listing falls back to the local cache when one exists", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const executable = await fakeMuse(directory, failing);
	const result = await isolated(discovery, { TEST_DIR: directory, XDG_DATA_HOME: data, PI_MUSE_BINARY: executable });
	expect(result.exitCode, result.stderr).toBe(0);
	expect(outcomeOf(result.stdout)).toEqual({ models: ["muse-spark", "muse-spark-contributor", "muse-test", "muse-test-contributor"], resolved: "muse-test", contributor: { modelId: "muse-test", contributor: true } });
}));
