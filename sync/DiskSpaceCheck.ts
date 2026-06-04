const LOG = "[DriveSync/DiskSpace]";

export interface DiskSpaceResult {
	ok: boolean;
	freeBytes: number | null;
	requiredBytes: number;
	reason?: string;
}

/**
 * Phase 13.1 — disk-space pre-flight. Aborts a sync before it starts if the expected
 * download (×2 safety factor) would not fit in free space. Uses navigator.storage.estimate
 * for a cross-platform estimate; returns ok=true when free space can't be determined
 * (don't block on unknowns).
 */
export async function checkDiskSpace(expectedBytes: number): Promise<DiskSpaceResult> {
	const requiredBytes = Math.max(0, expectedBytes) * 2;
	let freeBytes: number | null = null;
	try {
		if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
			const est = await navigator.storage.estimate();
			if (typeof est.quota === "number" && typeof est.usage === "number") {
				freeBytes = est.quota - est.usage;
			}
		}
	} catch (e) {
		console.warn(`${LOG} storage.estimate() failed:`, e);
	}

	if (freeBytes === null) {
		return { ok: true, freeBytes: null, requiredBytes };
	}
	if (requiredBytes > freeBytes) {
		return {
			ok: false,
			freeBytes,
			requiredBytes,
			reason: `Need ~${fmt(requiredBytes)} free (2× expected), but only ${fmt(freeBytes)} available.`,
		};
	}
	return { ok: true, freeBytes, requiredBytes };
}

function fmt(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}
