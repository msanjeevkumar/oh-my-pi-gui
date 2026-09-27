import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

/** Read the version from the same bundled binary used for GUI sessions. */
export async function getBundledOmpVersion(binaryPath: string | null): Promise<string | null> {
	if (!binaryPath) return null;
	try {
		const { stdout } = await promisify(execFile)(resolve(binaryPath), ["--version"], {
			timeout: 5000,
			maxBuffer: 1024,
			windowsHide: true,
		});
		return /^omp\/(\S+)$/.exec(stdout.trim())?.[1] ?? null;
	} catch {
		return null;
	}
}
