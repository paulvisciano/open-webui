import { CHUNK_SIZE } from './constants';
import type { CanvasNode } from './types';

export type WallNavNode = Pick<CanvasNode, 'id' | 'kind' | 'yaw' | 'cellZ' | 'localY' | 'localZ'>;

function wallZ(n: WallNavNode): number {
  return n.cellZ * CHUNK_SIZE + n.localZ;
}

function sameWall(a: WallNavNode, b: WallNavNode): boolean {
  const ay = a.yaw ?? 0;
  const by = b.yaw ?? 0;
  if (ay === 0 || by === 0) return false;
  return Math.sign(ay) === Math.sign(by);
}

function isWallMedia(n: WallNavNode): boolean {
  return n.kind === 'photo' || n.kind === 'video';
}

export function wallNeighborId(nodes: readonly WallNavNode[], id: string, dir: 1 | -1): string | null {
  const current = nodes.find((n) => n.id === id);
  if (!current || !isWallMedia(current) || !current.yaw) return null;
  const wall = nodes.filter((n) => isWallMedia(n) && sameWall(n, current));
  wall.sort((a, b) => {
    const dz = wallZ(a) - wallZ(b);
    if (dz !== 0) return dz;
    return a.localY - b.localY;
  });
  const i = wall.findIndex((n) => n.id === id);
  if (i < 0) return null;
  return wall[i + dir]?.id ?? null;
}
