import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { UsageLimit, UsageProvider } from "@oh-my-pi/pi-ai/usage";

const execFileAsync = promisify(execFile);

export const museUsageProvider: UsageProvider = {
	id: "muse-bridge",
	validatesCredentials: false,
	async fetchUsage({ signal, credential }) {
		if (signal?.aborted) return null;
		try {
			const { stdout } = await execFileAsync(process.env.PI_MUSE_BINARY?.trim() || "muse", ["usage", "--json"], {
				signal, timeout: 15_000, maxBuffer: 1024 * 1024,
			});
			const data = JSON.parse(stdout);
			if (data?.schemaVersion !== 1 || !data.allowance || typeof data.allowance !== "object") return null;
			const limits: UsageLimit[] = [];
			for (const [key, id, label, durationMs] of [
				["window", "5h", "5 Hour", 5 * 60 * 60 * 1000],
				["weekly", "7d", "7 Day", 7 * 24 * 60 * 60 * 1000],
			] as const) {
				const source = data.allowance[key];
				if (typeof source?.usedPercent !== "number" || !Number.isFinite(source.usedPercent) || source.usedPercent < 0) continue;
				const usedFraction = source.usedPercent / 100;
				limits.push({
					id: `muse-bridge:${id}`, label,
					scope: { provider: "muse-bridge", ...(credential?.accountId ? { accountId: credential.accountId } : {}), windowId: id },
					amount: { usedFraction, unit: "percent" },
					window: { id, label, durationMs, ...(typeof source.resetsAtMs === "number" && Number.isFinite(source.resetsAtMs) ? { resetsAt: source.resetsAtMs } : {}) },
					status: usedFraction >= 1 ? "exhausted" : usedFraction >= 0.8 ? "warning" : "ok",
				});
			}
			return limits.length ? { provider: "muse-bridge", fetchedAt: Date.now(), limits } : null;
		} catch {
			return null;
		}
	},
};
