import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { bundledOmpFilename, getBundledOmpVersion } from "./bundled-omp-path";

describe("bundledOmpFilename", () => {
	it("uses the host sidecar filename", () => {
		expect(bundledOmpFilename()).toBe(process.platform === "win32" ? "omp.exe" : "omp");
	});
});

it.skipIf(process.platform === "win32")("reports only the exact bundled binary's version", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-about-"));
	const binary = path.join(directory, "omp");
	try {
		await fs.writeFile(binary, "#!/usr/bin/env bun\nconsole.log('omp/9.8.7-test')\n");
		await fs.chmod(binary, 0o755);
		expect(await getBundledOmpVersion(binary)).toBe("9.8.7-test");
		await fs.writeFile(binary, "#!/usr/bin/env bun\nconsole.log('not an omp version')\n");
		expect(await getBundledOmpVersion(binary)).toBeNull();
		await fs.unlink(binary);
		expect(await getBundledOmpVersion(binary)).toBeNull();
		expect(await getBundledOmpVersion(null)).toBeNull();
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
