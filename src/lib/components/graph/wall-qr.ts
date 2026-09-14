import * as THREE from 'three';
import { drawWallQrPlaque } from './qr';

export function qrWorldSize(planeHeight: number): number {
	return Math.max(14, Math.min(22, planeHeight * 0.32));
}

export function wallQrLocalOffset(
	width: number,
	height: number,
	qrWorld: number,
	gap = 8
): { lx: number; ly: number; lz: number } {
	return {
		lx: -(width / 2 + qrWorld / 2 + gap),
		ly: -(height / 2) + qrWorld * 0.5 + 2,
		lz: 0.45
	};
}

export function wallQrWorldFromCenter(
	cx: number,
	cy: number,
	cz: number,
	yaw: number,
	local: { lx: number; ly: number; lz: number }
): { x: number; y: number; z: number } {
	const cos = Math.cos(yaw);
	const sin = Math.sin(yaw);
	return {
		x: cx + local.lx * cos + local.lz * sin,
		y: cy + local.ly,
		z: cz - local.lx * sin + local.lz * cos
	};
}

type PlaneRef = {
	mesh: THREE.Mesh;
	node: { width: number; height: number; yaw?: number };
};

export class WallQr {
	private readonly _mesh: THREE.Mesh;
	private readonly _material: THREE.MeshBasicMaterial;
	private _targetId: string | null = null;
	private _url: string | null = null;

	constructor(private readonly _scene: THREE.Scene) {
		this._material = new THREE.MeshBasicMaterial({
			transparent: true,
			depthWrite: false,
			fog: true,
			side: THREE.FrontSide
		});
		this._mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this._material);
		this._mesh.visible = false;
		this._mesh.frustumCulled = false;
		this._mesh.name = 'wall-qr';
		this._scene.add(this._mesh);
	}

	set(nodeId: string | null, url: string | null): void {
		if (!nodeId || !url) {
			this._targetId = null;
			this._url = null;
			this._mesh.visible = false;
			return;
		}
		if (this._url !== url) this._bake(url);
		this._targetId = nodeId;
		this._url = url;
	}

	tick(findPlane: (id: string) => PlaneRef | undefined): void {
		if (!this._targetId) {
			this._mesh.visible = false;
			return;
		}
		const plane = findPlane(this._targetId);
		if (!plane) {
			this._mesh.visible = false;
			return;
		}
		plane.mesh.updateWorldMatrix(true, false);
		const world = new THREE.Vector3();
		plane.mesh.getWorldPosition(world);
		const qrWorld = qrWorldSize(plane.node.height);
		const local = wallQrLocalOffset(plane.node.width, plane.node.height, qrWorld);
		const pos = wallQrWorldFromCenter(world.x, world.y, world.z, plane.node.yaw ?? 0, local);
		this._mesh.position.set(pos.x, pos.y, pos.z);
		this._mesh.rotation.copy(plane.mesh.rotation);
		this._mesh.scale.set(qrWorld, qrWorld, 1);
		this._mesh.visible = true;
	}

	dispose(): void {
		this._scene.remove(this._mesh);
		this._mesh.geometry.dispose();
		this._material.map?.dispose();
		this._material.dispose();
	}

	private _bake(url: string): void {
		this._material.map?.dispose();
		const canvas = drawWallQrPlaque(url);
		const tex = new THREE.CanvasTexture(canvas);
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.generateMipmaps = false;
		tex.minFilter = THREE.LinearFilter;
		tex.magFilter = THREE.NearestFilter;
		tex.needsUpdate = true;
		this._material.map = tex;
		this._material.needsUpdate = true;
	}
}
