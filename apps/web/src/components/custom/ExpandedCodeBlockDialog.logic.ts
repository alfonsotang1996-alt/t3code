export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;
export const DEFAULT_ZOOM = 1;

const ZOOM_STEP = 0.25;
const WHEEL_ZOOM_SENSITIVITY = 0.0025;
const PLAIN_TEXT_LANGUAGE_REGEX = /^(?:text|txt|plain|plaintext)?$/i;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return DEFAULT_ZOOM;
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  return Math.round(clamped * 10_000) / 10_000;
}

export function stepZoom(currentZoom: number, direction: 1 | -1): number {
  const base = Number.isFinite(currentZoom) ? currentZoom : DEFAULT_ZOOM;
  return clampZoom(Math.round((base + direction * ZOOM_STEP) * 100) / 100);
}

export function applyWheelZoom(currentZoom: number, deltaY: number): number {
  const base = clampZoom(currentZoom);
  if (!Number.isFinite(deltaY) || deltaY === 0) return base;
  return clampZoom(base * Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY));
}

export function calculateFitZoom(availableWidth: number, contentWidth: number): number {
  if (
    !Number.isFinite(availableWidth) ||
    !Number.isFinite(contentWidth) ||
    availableWidth <= 0 ||
    contentWidth <= 0
  ) {
    return DEFAULT_ZOOM;
  }
  // Floor to two decimals so fitted diagrams stay inside the viewport without horizontal overflow.
  return clampZoom(Math.floor((availableWidth / contentWidth) * 100) / 100);
}

export function formatZoomPercent(zoom: number): string {
  return `${Math.round(clampZoom(zoom) * 100)}%`;
}

export function isPlainTextLanguage(language: string): boolean {
  return PLAIN_TEXT_LANGUAGE_REGEX.test(language.trim());
}
