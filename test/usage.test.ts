import { test, expect } from "bun:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { museUsageProvider } from "../src/usage.ts";

const params = { provider: "muse-bridge", credential: { type: "api_key" as const } };
const context = { fetch: globalThis.fetch };

test("reads Muse allowance windows without inventing missing values", async () => {
	const directory = await mkdtemp(join(tmpdir(), "muse-usage-"));
	const binary = join(directory, "muse");
	const previous = process.env.PI_MUSE_BINARY;
	try {
		await writeFile(binary, `#!/bin/sh\n[ "$1" = usage ] && [ "$2" = --json ] || exit 1\nprintf '%s' '{"schemaVersion":1,"allowance":{"window":{"usedPercent":0,"resetsAtMs":12345},"weekly":{"usedPercent":87,"resetsAtMs":67890}}}'\n`);
		await chmod(binary, 0o755);
		process.env.PI_MUSE_BINARY = binary;
		const report = await museUsageProvider.fetchUsage(params, context);
		expect(report?.limits.map(({ amount, window, status }) => [amount.usedFraction, window?.resetsAt, status])).toEqual([[0, 12345, "ok"], [0.87, 67890, "warning"]]);
		await writeFile(binary, `#!/bin/sh\nprintf '%s' '{"schemaVersion":1,"allowance":{"weekly":{"usedPercent":100}}}'\n`);
		const partial = await museUsageProvider.fetchUsage(params, context);
		expect(partial?.limits.map(({ id, status }) => [id, status])).toEqual([["muse-bridge:7d", "exhausted"]]);
		await writeFile(binary, "#!/bin/sh\nprintf invalid\n");
		expect(await museUsageProvider.fetchUsage(params, context)).toBeNull();
		await writeFile(binary, "#!/bin/sh\nexit 1\n");
		expect(await museUsageProvider.fetchUsage(params, context)).toBeNull();
	} finally {
		if (previous === undefined) delete process.env.PI_MUSE_BINARY; else process.env.PI_MUSE_BINARY = previous;
		await rm(directory, { recursive: true, force: true });
	}
});
