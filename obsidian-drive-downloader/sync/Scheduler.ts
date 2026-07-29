export class Scheduler {
	private intervalId: number | null = null;

	start(intervalMinutes: number, callback: () => Promise<unknown>): void {
		this.stop();
		if (intervalMinutes <= 0) return;

		// Phase 13.3 — enforce a hard 60-second floor regardless of the configured value.
		const MIN_MS = 60 * 1000;
		let ms = intervalMinutes * 60 * 1000;
		if (ms < MIN_MS) {
			console.warn(`[DriveSync] Sync interval below 60s — clamping to 60s.`);
			ms = MIN_MS;
		}
		this.intervalId = window.setInterval(async () => {
			try {
				await callback();
			} catch (e) {
				console.error("[DriveSync] Scheduled sync error:", e);
			}
		}, ms) as unknown as number;
	}

	stop(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	restart(intervalMinutes: number, callback: () => Promise<unknown>): void {
		this.stop();
		this.start(intervalMinutes, callback);
	}
}
