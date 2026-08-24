/**
 * OWUI graph API client — adapts KG's `kg-api-client.ts` to OWUI's
 * `/api/v1/graph/` router.  Uses `authorization: Bearer <token>` from
 * `localStorage`, matching the rest of `$lib/apis/*`.  Exported function
 * names mirror KG's `KgApiClient` so ported components can drop this in
 * as a near-1:1 replacement for the KG `kgApiClient` singleton.
 */

import { WEBUI_API_BASE_URL } from '$lib/constants';

const GRAPH_BASE = `${WEBUI_API_BASE_URL}/graph`;

export interface ProcessResult {
  exif: Record<string, unknown> | null;
  faces: Record<string, unknown> | null;
  captions: string[];
  content_list: Record<string, unknown>[];
  inserted: boolean;
}

export interface JobInfo {
  job_id: string;
  file_source: string;
  status: string;
  stage: string;
  error?: string;
  created_at: number;
  updated_at: number;
}

export interface LabelFaceResult {
  status: string;
  face_id: string;
  old_name: string;
  new_name: string;
  entity_renamed: boolean;
}

function getToken(): string {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem('token') ?? '';
  }
  return '';
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${getToken()}`,
    ...extra,
  };
}

// URL builders mirror KG's API.kg helpers but target /api/v1/graph.

function photoImageUrl(filename: string, w: string | number = 256): string {
  const url = new URL(
    `${GRAPH_BASE}/images/photo/${encodeURIComponent(filename)}`,
    window.location.origin
  );
  url.searchParams.set('w', `${w}`);
  return url.toString();
}

function photoImageFullUrl(filename: string): string {
  return photoImageUrl(filename, 'full');
}

function photoExifUrl(fileSource: string): string {
  return `${GRAPH_BASE}/images/exif/${encodeURIComponent(fileSource)}`;
}

function faceCropUrl(name: string): string {
  return `${GRAPH_BASE}/images/faces/crops/${encodeURIComponent(name)}`;
}

function faceCropByIdUrl(faceId: string): string {
  return `${GRAPH_BASE}/images/faces/crops/by-id/${encodeURIComponent(faceId)}`;
}

function deletePhotoEntitiesUrl(fileSource: string): string {
  return `${GRAPH_BASE}/images/photo-entities?file_source=${encodeURIComponent(fileSource)}`;
}

// Some DELETE/POST endpoints return an empty body; guard against JSON parse errors.

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Graph API ${res.status} ${res.statusText}: ${body}`);
  }
  // Some DELETE / POST endpoints return empty body; guard against JSON parse errors.
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export const getGraphHealth = async (): Promise<{ status: string; service: string }> => {
  return request<{ status: string; service: string }>(`${GRAPH_BASE}/health`);
};

export const createJob = async (
  file: File,
  options: { skipExif?: boolean; skipFaces?: boolean; insert?: boolean; note?: string } = {}
): Promise<JobInfo> => {
  const formData = new FormData();
  formData.append('file', file);
  if (options.skipExif !== undefined) formData.append('skip_exif', String(options.skipExif));
  if (options.skipFaces !== undefined) formData.append('skip_faces', String(options.skipFaces));
  if (options.insert !== undefined) formData.append('insert', String(options.insert));
  if (options.note !== undefined) formData.append('note', options.note);
  return request<JobInfo>(`${GRAPH_BASE}/images/jobs`, {
    method: 'POST',
    body: formData,
  });
};

export const listJobs = async (statusFilter?: string): Promise<JobInfo[]> => {
  const url = statusFilter
    ? `${GRAPH_BASE}/images/jobs?status=${encodeURIComponent(statusFilter)}`
    : `${GRAPH_BASE}/images/jobs`;
  return request<JobInfo[]>(url);
};

export const getJob = async (jobId: string): Promise<JobInfo> => {
  return request<JobInfo>(`${GRAPH_BASE}/images/jobs/${encodeURIComponent(jobId)}`);
};

export const processAIQueue = async (): Promise<{ status: string; processed: number }> => {
  return request<{ status: string; processed: number }>(`${GRAPH_BASE}/images/queue/process`, {
    method: 'POST',
  });
};

export const clearFailedJobs = async (fileSource: string): Promise<{ status: string; deleted: number }> => {
  const formData = new FormData();
  formData.append('file_source', fileSource);
  return request<{ status: string; deleted: number }>(`${GRAPH_BASE}/images/jobs/failed`, {
    method: 'POST',
    body: formData,
  });
};

export const clearAllFailedJobs = async (): Promise<{ status: string; deleted: number }> => {
  return request<{ status: string; deleted: number }>(`${GRAPH_BASE}/images/jobs/failed/all`, {
    method: 'POST',
  });
};

export const processImage = async (
  file: File,
  options: { skipExif?: boolean; skipFaces?: boolean; insert?: boolean } = {}
): Promise<ProcessResult> => {
  const formData = new FormData();
  formData.append('file', file);
  if (options.skipExif !== undefined) formData.append('skip_exif', String(options.skipExif));
  if (options.skipFaces !== undefined) formData.append('skip_faces', String(options.skipFaces));
  if (options.insert !== undefined) formData.append('insert', String(options.insert));
  return request<ProcessResult>(`${GRAPH_BASE}/images/process`, {
    method: 'POST',
    body: formData,
  });
};

/**
 * Stream Server-Sent Events from `POST /images/process` (SSE variant).
 * Returns an async iterable of `{ event, data }` plus a `cancel()` handle.
 */
export function processImageSse(
  file: File,
  options: { skipExif?: boolean; skipFaces?: boolean; insert?: boolean } = {}
): { stream: AsyncIterable<{ event: string; data: string }>; cancel: () => void } {
  const formData = new FormData();
  formData.append('file', file);
  if (options.skipExif !== undefined) formData.append('skip_exif', String(options.skipExif));
  if (options.skipFaces !== undefined) formData.append('skip_faces', String(options.skipFaces));
  if (options.insert !== undefined) formData.append('insert', String(options.insert));

  const controller = new AbortController();
  const url = `${GRAPH_BASE}/images/process`;

  const stream = (async function* (): AsyncIterable<{ event: string; data: string }> {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(),
      body: formData,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Graph API ${res.status} ${res.statusText}: ${body}`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;
          yield { event: 'message', data };
        }
      }
    }
  })();

  return {
    stream,
    cancel: () => controller.abort(),
  };
}

/**
 * Re-process an already-ingested image by `file_source` via SSE.
 */
export function reprocessImageSse(
  fileSource: string,
  options: { skipExif?: boolean; skipFaces?: boolean } = {}
): { stream: AsyncIterable<{ event: string; data: string }>; cancel: () => void } {
  const formData = new FormData();
  formData.append('file_source', fileSource);
  if (options.skipExif !== undefined) formData.append('skip_exif', String(options.skipExif));
  if (options.skipFaces !== undefined) formData.append('skip_faces', String(options.skipFaces));

  const controller = new AbortController();
  const url = `${GRAPH_BASE}/images/reprocess`;

  const stream = (async function* (): AsyncIterable<{ event: string; data: string }> {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(),
      body: formData,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Graph API ${res.status} ${res.statusText}: ${body}`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;
          yield { event: 'message', data };
        }
      }
    }
  })();

  return {
    stream,
    cancel: () => controller.abort(),
  };
}

export const deletePhotoEntities = async (
  fileSource: string
): Promise<{
  entities_deleted: { name: string; status: string }[];
  errors: unknown[];
}> => {
  return request(deletePhotoEntitiesUrl(fileSource), { method: 'DELETE' });
};

export const labelFace = async (
  faceId: string,
  newName: string
): Promise<LabelFaceResult> => {
  return request<LabelFaceResult>(`${GRAPH_BASE}/images/faces/label`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ face_id: faceId, new_name: newName }),
  });
};

/**
 * Stream job events for a single job id from `GET /images/jobs/{id}/events`.
 * Mirrors KG's `streamJobEvents` shape (async iterable + cancel).
 */
export function streamJobEvents(
  jobId: string,
  after: number = 0
): { stream: AsyncIterable<{ event: string; data: string; eventId?: number }>; cancel: () => void } {
  const controller = new AbortController();
  const url = new URL(
    `${GRAPH_BASE}/images/jobs/${encodeURIComponent(jobId)}/events`,
    window.location.origin
  );
  if (after > 0) url.searchParams.set('after', String(after));

  const stream = (async function* (): AsyncIterable<{ event: string; data: string; eventId?: number }> {
    const res = await fetch(url.toString(), {
      headers: authHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Graph API ${res.status} ${res.statusText}: ${body}`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;
          let eventId: number | undefined;
          const idMatch = line.match(/^id:\s*(\d+)/m);
          if (idMatch) eventId = parseInt(idMatch[1], 10);
          try {
            const parsed = JSON.parse(data);
            eventId = parsed.event_id ?? eventId;
          } catch {
            /* ignore */
          }
          yield { event: 'message', data, eventId };
        }
      }
    }
  })();

  return {
    stream,
    cancel: () => controller.abort(),
  };
}

export {
  photoImageUrl,
  photoImageFullUrl,
  photoExifUrl,
  faceCropUrl,
  faceCropByIdUrl,
  deletePhotoEntitiesUrl,
};

// Class wrapper mirrors KG's `KgApiClient` singleton so ported components
// can swap `kgApiClient` → `graphApiClient` with minimal churn.

class GraphApiClient {
  health = getGraphHealth;
  createJob = createJob;
  listJobs = listJobs;
  getJob = getJob;
  processAIQueue = processAIQueue;
  clearFailedJobs = clearFailedJobs;
  clearAllFailedJobs = clearAllFailedJobs;
  processImage = processImage;
  processImageSse = processImageSse;
  reprocessImageSse = reprocessImageSse;
  deletePhotoEntities = deletePhotoEntities;
  labelFace = labelFace;
  streamJobEvents = streamJobEvents;
  photoImageUrl = photoImageUrl;
  photoImageFullUrl = photoImageFullUrl;
  photoExifUrl = photoExifUrl;
  faceCropUrl = faceCropUrl;
  faceCropByIdUrl = faceCropByIdUrl;
}

export const graphApiClient = new GraphApiClient();