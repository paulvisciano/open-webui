<script lang="ts">
	let {
		rms = 0,
		mode = 'idle'
	}: {
		rms: number;
		mode: 'idle' | 'user' | 'assistant';
	} = $props();

	let canvas: HTMLCanvasElement | undefined = $state();
	const latest = { rms, mode };

	$effect(() => {
		latest.rms = rms;
		latest.mode = mode;
	});

	$effect(() => {
		const el = canvas;
		if (!el) return;
		const ctx = el.getContext('2d');
		if (!ctx) return;

		let raf = 0;
		let running = true;

		const fit = () => {
			const dpr = window.devicePixelRatio || 1;
			const w = el.clientWidth;
			const h = el.clientHeight;
			el.width = Math.floor(w * dpr);
			el.height = Math.floor(h * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		};
		fit();

		const blob = (
			cx: number,
			cy: number,
			r: number,
			t: number,
			energy: number,
			freq: number,
			phase: number
		) => {
			ctx.beginPath();
			const n = 72;
			for (let i = 0; i <= n; i++) {
				const a = (i / n) * Math.PI * 2;
				const wobble =
					1 +
					energy * 0.2 * Math.sin(a * 3 + t * freq + phase) +
					energy * 0.12 * Math.sin(a * 5 - t * freq * 0.7 + phase);
				const x = cx + Math.cos(a) * r * wobble;
				const y = cy + Math.sin(a) * r * wobble * 0.74;
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			ctx.closePath();
		};

		const draw = () => {
			if (!running) return;
			const w = el.clientWidth;
			const h = el.clientHeight;
			ctx.clearRect(0, 0, w, h);

			const t = performance.now() / 1000;
			const { rms: level, mode: tone } = latest;
			const energy =
				tone === 'user'
					? Math.min(1, 0.22 + level * 14)
					: tone === 'assistant'
						? 0.42
						: 0.12;
			const speed = tone === 'idle' ? 0.7 : 1.8;
			const cx = w / 2;
			const cy = h / 2;
			const r = Math.min(w, h) * 0.32;

			const glow = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 1.6);
			glow.addColorStop(0, 'oklch(82% 0.14 210 / 28%)');
			glow.addColorStop(0.55, 'oklch(70% 0.1 200 / 10%)');
			glow.addColorStop(1, 'oklch(70% 0.1 200 / 0%)');
			ctx.fillStyle = glow;
			ctx.fillRect(0, 0, w, h);

			ctx.fillStyle = 'oklch(82% 0.12 210 / 18%)';
			blob(cx, cy, r * 1.15, t, energy, speed, 0.4);
			ctx.fill();

			ctx.fillStyle = 'oklch(86% 0.13 200 / 45%)';
			blob(cx, cy, r, t, energy, speed, 0);
			ctx.fill();

			ctx.fillStyle = 'oklch(92% 0.08 200 / 70%)';
			blob(cx, cy, r * 0.62, t * 1.15, energy * 0.8, speed * 1.2, 1.2);
			ctx.fill();

			raf = requestAnimationFrame(draw);
		};

		raf = requestAnimationFrame(draw);
		return () => {
			running = false;
			cancelAnimationFrame(raf);
		};
	});
</script>

<canvas bind:this={canvas} class="voice-wave" aria-hidden="true"></canvas>

<style>
	.voice-wave {
		display: block;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}
</style>
