import { describe, expect, it } from 'vitest';
import { qrWorldSize, wallQrLocalOffset, wallQrWorldFromCenter } from './wall-qr';

describe('wall QR placement', () => {
	it('keeps the plaque on the wall plane, left of the painting', () => {
		const qrWorld = qrWorldSize(60);
		const local = wallQrLocalOffset(40, 60, qrWorld, 8);
		expect(local.lx).toBeLessThan(0);
		expect(local.lz).toBeGreaterThan(0);
		expect(qrWorld).toBeGreaterThanOrEqual(14);
		expect(qrWorld).toBeLessThanOrEqual(22);
	});

	it('offsets along the right wall toward the hallway', () => {
		const yaw = -Math.PI / 2;
		const local = { lx: -30, ly: -10, lz: 0.45 };
		const world = wallQrWorldFromCenter(80, 0, 100, yaw, local);
		expect(world.x).toBeCloseTo(80 - 0.45);
		expect(world.y).toBe(-10);
		expect(world.z).toBeCloseTo(100 - 30);
	});
});
