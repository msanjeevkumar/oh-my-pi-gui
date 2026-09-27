import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

/** Filename of the bundled omp sidecar on this platform. */
export function bundledOmpFilename(): string {
	return process.platform === "win32" ? "omp.exe" : "omp";
}

/** Resolve a bundled sidecar path, accepting a Windows .exe suffix when needed. */
export function resolveOmpCandidate(...parts: string[]): string | null {
	const candidate = join(...parts);
	if (existsSync(candidate)) return candidate;
	if (process.platform === "win32" && !candidate.toLowerCase().endsWith(".exe")) {
		const withExe = `${candidate}.exe`;
		if (existsSync(withExe)) return withExe;
	}
	return null;
}

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
