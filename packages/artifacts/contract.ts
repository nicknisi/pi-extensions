/** Optional plugin-services:v1 compatibility contract. No runtime imports or side effects. */
export const ARTIFACTS_SERVICE = Object.freeze({
  id: 'nicknisi.artifacts',
  apiMajor: 1,
  discoveryEvent: 'plugin-services:v1:discover:nicknisi.artifacts',
} as const);

export interface ArtifactFeedback {
  slug: string;
  markdown: string;
  annotationIds: string[];
}

/**
 * A page asking its owning session to do something, e.g. `{ action: 'approve' }`
 * from a `[data-artifact-action="approve"]` button. It is a request, never
 * permission: the subscriber decides what, if anything, happens, and any
 * process that can reach the local server could send one.
 */
export interface ArtifactRequest {
  slug: string;
  action: string;
}

/** Action names a page may request: short, lowercase, kebab-case. */
export const ARTIFACT_ACTION = /^[a-z][a-z0-9-]{0,31}$/;

export interface ArtifactsAPI {
  publish(input: {
    title: string;
    html: string;
    open?: boolean;
  }): Promise<{ slug: string; url: string; absPath: string }>;
  answer(input: { slug: string; annotationId: string; content: string }): Promise<{ ok: true }>;
  subscribe(input: {
    slug: string;
    onFeedback: (feedback: ArtifactFeedback) => boolean | Promise<boolean>;
    /** Page requests this subscriber accepts; buttons for other actions stay hidden. */
    actions?: string[];
    /** Resolve true once the request reached its owner. Required with `actions`. */
    onRequest?: (request: ArtifactRequest) => boolean | Promise<boolean>;
  }): Promise<() => void>;
}

/** Shape/major compatibility only, not authentication or a security boundary. Never calls methods/getters. */
export function isArtifactsAPI(value: unknown): value is ArtifactsAPI {
  if (!value || typeof value !== 'object') return false;
  return ['publish', 'answer', 'subscribe'].every((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property !== undefined && 'value' in property && typeof property.value === 'function';
  });
}

export function isArtifactsOffer(value: unknown): value is { id: string; apiMajor: 1; api: ArtifactsAPI } {
  if (!value || typeof value !== 'object') return false;
  const own = (key: string) => Object.getOwnPropertyDescriptor(value, key)?.value;
  return (
    own('id') === ARTIFACTS_SERVICE.id && own('apiMajor') === ARTIFACTS_SERVICE.apiMajor && isArtifactsAPI(own('api'))
  );
}
