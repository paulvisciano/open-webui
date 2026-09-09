/**
 * Library-scan progress — distinct from VLM image processing.
 * Stages: walking → indexing → complete | error.
 */

export type ScanStage = 'walking' | 'indexing' | 'complete' | 'error';

export interface ScanCounts {
	seen?: number;
	upserted?: number;
}

export interface ScanProgress {
	sourceId: string;
	name: string;
	stage: ScanStage;
	seen: number;
	upserted: number;
	error?: string;
	updatedAt: number;
	get stageLabel(): string;
	get countLabel(): string;
	get stepper(): { stage: ScanStage; label: string; state: 'pending' | 'current' | 'done' }[];
}

const SCAN_ORDER: ScanStage[] = ['walking', 'indexing', 'complete'];

const STAGE_LABELS: Record<ScanStage, string> = {
	walking: 'Walking library…',
	indexing: 'Indexing files…',
	complete: 'Scan complete',
	error: 'Scan failed'
};

function attachComputed(job: Omit<ScanProgress, 'stageLabel' | 'countLabel' | 'stepper'>): ScanProgress {
	return {
		...job,
		get stageLabel() {
			return STAGE_LABELS[this.stage] ?? this.stage;
		},
		get countLabel() {
			if (this.seen <= 0 && this.upserted <= 0) return '';
			return `seen ${this.seen} · indexed ${this.upserted}`;
		},
		get stepper() {
			const currentIdx =
				this.stage === 'error' ? -1 : this.stage === 'complete' ? SCAN_ORDER.length - 1 : SCAN_ORDER.indexOf(this.stage);
			return SCAN_ORDER.map((s) => {
				const sIdx = SCAN_ORDER.indexOf(s);
				const state: 'pending' | 'current' | 'done' =
					currentIdx < 0 ? 'pending' : currentIdx > sIdx ? 'done' : currentIdx === sIdx ? 'current' : 'pending';
				return { stage: s, label: STAGE_LABELS[s], state };
			});
		}
	};
}

export function countsFromScanResponse(res: unknown): ScanCounts {
	if (!res || typeof res !== 'object') return {};
	const r = res as Record<string, unknown>;
	const seen = typeof r.seen === 'number' && Number.isFinite(r.seen) ? r.seen : undefined;
	const upserted = typeof r.upserted === 'number' && Number.isFinite(r.upserted) ? r.upserted : undefined;
	return { ...(seen != null ? { seen } : {}), ...(upserted != null ? { upserted } : {}) };
}

class ScanProgressStore {
	jobs = $state<Record<string, ScanProgress>>({});

	start(sourceId: string, name: string, counts?: ScanCounts): void {
		if (!sourceId) return;
		const existing = this.jobs[sourceId];
		if (existing && existing.stage !== 'complete' && existing.stage !== 'error') {
			if (name) existing.name = name;
			this.applyCounts(sourceId, counts);
			return;
		}
		const seen = counts?.seen ?? 0;
		const upserted = counts?.upserted ?? 0;
		this.jobs[sourceId] = attachComputed({
			sourceId,
			name: name || sourceId,
			stage: seen > 0 ? 'indexing' : 'walking',
			seen,
			upserted,
			updatedAt: Date.now()
		});
		this.jobs = { ...this.jobs };
	}

	ensure(sourceId: string, name?: string): void {
		if (!sourceId) return;
		if (!this.jobs[sourceId] || this.jobs[sourceId].stage === 'complete' || this.jobs[sourceId].stage === 'error') {
			this.start(sourceId, name || sourceId);
			return;
		}
		if (name && this.jobs[sourceId].name !== name) {
			this.jobs[sourceId].name = name;
			this.jobs = { ...this.jobs };
		}
	}

	applyCounts(sourceId: string, counts?: ScanCounts): void {
		const job = this.jobs[sourceId];
		if (!job || !counts) return;
		if (counts.seen != null) job.seen = counts.seen;
		if (counts.upserted != null) job.upserted = counts.upserted;
		if (job.stage === 'walking' && job.seen > 0) job.stage = 'indexing';
		job.updatedAt = Date.now();
		this.jobs = { ...this.jobs };
	}

	applyPoll(
		sourceId: string,
		opts: { scanning: boolean; seen: number; upserted: number; name?: string }
	): void {
		if (!sourceId) return;
		this.ensure(sourceId, opts.name);
		const job = this.jobs[sourceId];
		if (!job) return;
		job.seen = opts.seen;
		job.upserted = opts.upserted;
		if (opts.name) job.name = opts.name;
		if (job.stage === 'error') {
			job.updatedAt = Date.now();
			this.jobs = { ...this.jobs };
			return;
		}
		if (!opts.scanning) {
			job.stage = 'complete';
		} else {
			job.stage = opts.seen > 0 ? 'indexing' : 'walking';
		}
		job.updatedAt = Date.now();
		this.jobs = { ...this.jobs };
	}

	complete(sourceId: string): void {
		const job = this.jobs[sourceId];
		if (!job || job.stage === 'error') return;
		job.stage = 'complete';
		job.updatedAt = Date.now();
		this.jobs = { ...this.jobs };
	}

	completeActive(): void {
		let changed = false;
		for (const job of Object.values(this.jobs)) {
			if (job.stage === 'walking' || job.stage === 'indexing') {
				job.stage = 'complete';
				job.updatedAt = Date.now();
				changed = true;
			}
		}
		if (changed) this.jobs = { ...this.jobs };
	}

	fail(sourceId: string, error?: string): void {
		this.ensure(sourceId);
		const job = this.jobs[sourceId];
		if (!job) return;
		job.stage = 'error';
		job.error = error;
		job.updatedAt = Date.now();
		this.jobs = { ...this.jobs };
	}

	remove(sourceId: string): void {
		if (!this.jobs[sourceId]) return;
		const next = { ...this.jobs };
		delete next[sourceId];
		this.jobs = next;
	}
}

export const scanProgressStore = new ScanProgressStore();
export const SCAN_STAGE_LABELS = STAGE_LABELS;
