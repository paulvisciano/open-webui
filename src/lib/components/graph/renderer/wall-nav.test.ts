import { describe, expect, it } from 'vitest';
import { wallNeighborId, type WallNavNode } from './wall-nav';

function node(partial: Partial<WallNavNode> & Pick<WallNavNode, 'id'>): WallNavNode {
	return {
		kind: 'photo',
		yaw: Math.PI / 2,
		cellZ: 0,
		localY: 0,
		localZ: 0,
		...partial
	};
}

describe('wallNeighborId', () => {
	const left = [
		node({ id: 'a', localZ: 0 }),
		node({ id: 'b', localZ: 260 }),
		node({ id: 'c', localZ: 520 }),
		node({ id: 'other-wall', yaw: -Math.PI / 2, localZ: 260 })
	];

	it('steps along the same wall and ignores the opposite wall', () => {
		expect(wallNeighborId(left, 'a', 1)).toBe('b');
		expect(wallNeighborId(left, 'b', 1)).toBe('c');
		expect(wallNeighborId(left, 'b', -1)).toBe('a');
		expect(wallNeighborId(left, 'c', 1)).toBeNull();
	});

	it('returns null for aisle nodes', () => {
		expect(wallNeighborId([node({ id: 'chat', kind: 'conversation', yaw: 0 })], 'chat', 1)).toBeNull();
	});
});
