import { WEBUI_API_BASE_URL } from '$lib/constants';
import type { KGNode } from '$lib/components/graph/constants';
import {
	toGraphAsset,
	toGraphBrowseEntry,
	toGraphSearchHit,
	toGraphSource,
	type GraphBrowseEntry,
	type GraphCanvas,
	type GraphSearchHit,
	type GraphSource
} from '$lib/components/graph/assets';

export type {
	GraphAsset,
	GraphBrowseEntry,
	GraphCanvas,
	GraphSearchHit,
	GraphSource
} from '$lib/components/graph/assets';
export { assetToKgNode } from '$lib/components/graph/assets';

export const getGraph = async (token: string = '') => {
	let error = null;

	const res = await fetch(`${WEBUI_API_BASE_URL}/graph/`, {
		method: 'GET',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			authorization: `Bearer ${token}`
		}
	})
		.then(async (res) => {
			if (!res.ok) throw await res.json();
			return res.json();
		})
		.then((json) => {
			return json;
		})
		.catch((err) => {
			error = err.detail;
			console.error(err);
			return null;
		});

	if (error) {
		throw error;
	}

	return res;
};

export const getConversations = async (token: string = '') => {
	let error = null;

	const res = await fetch(`${WEBUI_API_BASE_URL}/graph/conversations`, {
		method: 'GET',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			authorization: `Bearer ${token}`
		}
	})
		.then(async (res) => {
			if (!res.ok) throw await res.json();
			return res.json();
		})
		.then((json) => {
			return json;
		})
		.catch((err) => {
			error = err.detail;
			console.error(err);
			return null;
		});

	if (error) {
		throw error;
	}

	return res;
};

export const processImage = async (token: string = '', file: File) => {
	let error = null;

	const formData = new FormData();
	formData.append('file', file);

	const res = await fetch(`${WEBUI_API_BASE_URL}/graph/images/process`, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			authorization: `Bearer ${token}`
		},
		body: formData
	})
		.then(async (res) => {
			if (!res.ok) throw await res.json();
			return res.json();
		})
		.then((json) => {
			return json;
		})
		.catch((err) => {
			error = err.detail;
			console.error(err);
			return null;
		});

	if (error) {
		throw error;
	}

	return res;
};

export const getImageUrl = (filename: string, w: string | number | null = null) => {
	const url = new URL(
		`${WEBUI_API_BASE_URL}/graph/images/photo/${filename}`,
		window.location.origin
	);
	if (w !== null) {
		url.searchParams.append('w', `${w}`);
	}
	return url.toString();
};

export const getGraphHealth = async (token: string = '') => {
	let error = null;

	const res = await fetch(`${WEBUI_API_BASE_URL}/graph/health`, {
		method: 'GET',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			authorization: `Bearer ${token}`
		}
	})
		.then(async (res) => {
			if (!res.ok) throw await res.json();
			return res.json();
		})
		.then((json) => {
			return json;
		})
		.catch((err) => {
			error = err.detail;
			console.error(err);
			return null;
		});

	if (error) {
		throw error;
	}

	return res;
};

const graphHeaders = (token: string) => ({
	Accept: 'application/json',
	'Content-Type': 'application/json',
	authorization: `Bearer ${token}`
});

const graphErrorMessage = (err: unknown): string => {
	if (err && typeof err === 'object' && 'detail' in err) {
		const detail = (err as { detail: unknown }).detail;
		if (typeof detail === 'string' && detail) return detail;
		if (detail != null && detail !== '') return String(detail);
	}
	if (err instanceof Error && err.message) return err.message;
	if (typeof err === 'string' && err) return err;
	return 'Graph request failed';
};

const graphJson = async (url: string, token: string, init: RequestInit = {}) => {
	let error: Error | null = null;

	const res = await fetch(url, {
		...init,
		headers: {
			...graphHeaders(token),
			...(init.headers ?? {})
		}
	})
		.then(async (res) => {
			if (!res.ok) throw await res.json();
			return res.json();
		})
		.then((json) => {
			return json;
		})
		.catch((err) => {
			error = new Error(graphErrorMessage(err));
			console.error(err);
			return null;
		});

	if (error) {
		throw error;
	}

	return res;
};

const assetPathId = (id: string) => (id.startsWith('asset:') ? id.slice(6) : id);

export const browsePath = async (
	token: string = '',
	path: string = ''
): Promise<GraphBrowseEntry[]> => {
	const qs = new URLSearchParams({ path });
	const res = await graphJson(
		`${WEBUI_API_BASE_URL}/graph/sources/browse?${qs.toString()}`,
		token
	);
	const rows = Array.isArray(res) ? res : (res?.entries ?? res?.children ?? []);
	return rows.map(toGraphBrowseEntry);
};

export const attachSource = async (
	token: string = '',
	absPath: string,
	name?: string
): Promise<GraphSource> => {
	const res = await graphJson(`${WEBUI_API_BASE_URL}/graph/sources`, token, {
		method: 'POST',
		body: JSON.stringify({ abs_path: absPath, name })
	});
	return toGraphSource(res);
};

export const listSources = async (token: string = ''): Promise<GraphSource[]> => {
	const res = await graphJson(`${WEBUI_API_BASE_URL}/graph/sources`, token);
	const rows = Array.isArray(res) ? res : (res?.sources ?? []);
	return rows.map(toGraphSource);
};

export const startScan = async (token: string = '', sourceId: string) => {
	return await graphJson(`${WEBUI_API_BASE_URL}/graph/sources/${sourceId}/scan`, token, {
		method: 'POST'
	});
};

export const detachSource = async (token: string = '', sourceId: string) => {
	return await graphJson(
		`${WEBUI_API_BASE_URL}/graph/sources/${encodeURIComponent(sourceId)}`,
		token,
		{ method: 'DELETE' }
	);
};

export const getCanvas = async (token: string = ''): Promise<GraphCanvas> => {
	const res = await graphJson(`${WEBUI_API_BASE_URL}/graph/canvas`, token);
	return {
		sources: (res?.sources ?? []).map(toGraphSource),
		assets: (res?.assets ?? []).map(toGraphAsset),
		conversations: (res?.conversations ?? []) as KGNode[]
	};
};

const appendAuthToken = (url: URL): string => {
	const token = typeof localStorage !== 'undefined' ? localStorage.token : '';
	if (token) url.searchParams.set('token', token);
	return url.toString();
};

export const getAssetThumbUrl = (id: string, w: number = 512) => {
	const url = new URL(
		`${WEBUI_API_BASE_URL}/graph/assets/${encodeURIComponent(assetPathId(id))}/thumb`,
		window.location.origin
	);
	if (w !== 512) url.searchParams.set('w', String(w));
	return appendAuthToken(url);
};

export const getAssetFileUrl = (id: string) => {
	const url = new URL(
		`${WEBUI_API_BASE_URL}/graph/assets/${encodeURIComponent(assetPathId(id))}/file`,
		window.location.origin
	);
	return appendAuthToken(url);
};

export const getAssetExif = async (
	token: string = '',
	id: string
): Promise<Record<string, unknown>> => {
	const res = await graphJson(
		`${WEBUI_API_BASE_URL}/graph/assets/${encodeURIComponent(assetPathId(id))}/exif`,
		token
	);
	return res && typeof res === 'object' ? (res as Record<string, unknown>) : {};
};

export const revealAssetPath = async (token: string = '', id: string): Promise<string | null> => {
	const res = await graphJson(
		`${WEBUI_API_BASE_URL}/graph/assets/${encodeURIComponent(assetPathId(id))}/path`,
		token,
		{ method: 'POST' }
	);
	if (typeof res?.path === 'string' && res.path.length > 0) return res.path;
	return null;
};

export const searchGraph = async (
	token: string = '',
	q: string
): Promise<GraphSearchHit[]> => {
	const qs = new URLSearchParams({ q });
	const res = await graphJson(`${WEBUI_API_BASE_URL}/graph/search?${qs.toString()}`, token);
	const rows = Array.isArray(res) ? res : (res?.results ?? res?.hits ?? []);
	return rows.map(toGraphSearchHit);
};

export const setSourcePresence = async (
	token: string = '',
	sourceId: string,
	online: boolean
): Promise<GraphSource> => {
	const res = await graphJson(`${WEBUI_API_BASE_URL}/graph/sources/${sourceId}/presence`, token, {
		method: 'POST',
		body: JSON.stringify({ online })
	});
	return toGraphSource(res);
};