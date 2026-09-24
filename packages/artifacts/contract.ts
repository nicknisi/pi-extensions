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
