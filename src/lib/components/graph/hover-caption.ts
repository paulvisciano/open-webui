export function whenPhrase(ms: number, nowMs = Date.now()): string {
	const d = new Date(ms);
	const now = new Date(nowMs);
	const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
	const days = Math.round((start(now) - start(d)) / 86_400_000);
	if (days === 0) return 'today';
	if (days === 1) return 'yesterday';
	if (days > 1 && days < 7) {
		return `last ${d.toLocaleDateString(undefined, { weekday: 'long' })}`;
	}
	const sameYear = d.getFullYear() === now.getFullYear();
	return d.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		year: sameYear ? undefined : 'numeric'
	});
}

export function hoverCaption(kind: string | null | undefined, ms: number | null, nowMs = Date.now()): string {
	const when = ms != null && Number.isFinite(ms) ? whenPhrase(ms, nowMs) : '';
	if (kind === 'photo') return when ? `Relive ${when}` : 'Look closer';
	if (kind === 'video') return when ? `Watch ${when}` : 'Play this';
	if (kind === 'conversation') return when ? `Reopen ${when}` : 'Open this chat';
	if (kind === 'audio') return when ? `Hear ${when}` : 'Play this';
	if (kind === 'document' || kind === 'pdf') return when ? `Open ${when}` : 'Open this';
	return kind ? 'Look closer' : '';
}
