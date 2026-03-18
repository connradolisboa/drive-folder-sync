export class Scheduler {
	private intervalId: number | null = null;

	start(intervalMinutes: number, callback: () => Promise<unknown>): void {
		this.stop();
		if (intervalMinutes <= 0) return;

		const ms = intervalMinutes * 60 * 1000;
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
