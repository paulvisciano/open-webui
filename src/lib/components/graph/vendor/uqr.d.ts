declare module '$lib/components/graph/vendor/uqr.mjs' {
	export function encode(
		data: string,
		options?: {
			ecc?: 'L' | 'M' | 'Q' | 'H';
			border?: number;
			boostEcc?: boolean;
		}
	): {
		size: number;
		data: boolean[][];
	};
}
