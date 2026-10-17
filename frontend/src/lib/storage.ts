// localStorage that never throws (private mode, quota, SSR).

export function load<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null || value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota exceeded or storage disabled — non-critical */
  }
}

export const KEYS = {
  jd: "tailor.jd",
  resume: "tailor.resume",
  versions: "tailor.versions",
  options: "tailor.options",
  auth: "tailor.auth",
} as const;
