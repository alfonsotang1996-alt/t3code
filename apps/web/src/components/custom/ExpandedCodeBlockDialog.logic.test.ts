import { describe, expect, it } from "vite-plus/test";

import {
  applyWheelZoom,
  calculateFitZoom,
  clampZoom,
  DEFAULT_ZOOM,
  formatZoomPercent,
  isPlainTextLanguage,
  MAX_ZOOM,
  MIN_ZOOM,
  stepZoom,
} from "./ExpandedCodeBlockDialog.logic";

describe("ExpandedCodeBlockDialog logic", () => {
  it("clamps zoom values between 50% and 300%", () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(MIN_ZOOM)).toBe(MIN_ZOOM);
    expect(clampZoom(1.375)).toBe(1.375);
    expect(clampZoom(MAX_ZOOM)).toBe(MAX_ZOOM);
    expect(clampZoom(5)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ZOOM);
  });

  it("steps zoom in 25% increments within bounds", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(Number.NaN, 1)).toBe(1.25);
  });

  it("applies wheel zoom deltas and clamps to bounds", () => {
    const zoomedIn = applyWheelZoom(1, -120);
    expect(zoomedIn).toBeGreaterThan(1);
    expect(zoomedIn).toBeLessThanOrEqual(MAX_ZOOM);

    const zoomedOut = applyWheelZoom(1, 120);
    expect(zoomedOut).toBeLessThan(1);
    expect(zoomedOut).toBeGreaterThanOrEqual(MIN_ZOOM);

    expect(applyWheelZoom(1.5, 0)).toBe(1.5);
    expect(applyWheelZoom(1.5, Number.NaN)).toBe(1.5);
    expect(applyWheelZoom(1, -10_000)).toBe(MAX_ZOOM);
    expect(applyWheelZoom(1, 10_000)).toBe(MIN_ZOOM);
  });

  it("calculates fit-to-width zoom floored and clamped", () => {
    expect(calculateFitZoom(800, 1000)).toBe(0.8);
    expect(calculateFitZoom(800, 1001)).toBe(0.79);
    expect(calculateFitZoom(400, 2000)).toBe(MIN_ZOOM);
    expect(calculateFitZoom(1200, 800)).toBe(1.5);
    expect(calculateFitZoom(2000, 200)).toBe(MAX_ZOOM);
    expect(calculateFitZoom(0, 500)).toBe(DEFAULT_ZOOM);
    expect(calculateFitZoom(500, 0)).toBe(DEFAULT_ZOOM);
    expect(calculateFitZoom(Number.NaN, 500)).toBe(DEFAULT_ZOOM);
  });

  it("formats zoom percentage strings", () => {
    expect(formatZoomPercent(0.5)).toBe("50%");
    expect(formatZoomPercent(1)).toBe("100%");
    expect(formatZoomPercent(1.254)).toBe("125%");
    expect(formatZoomPercent(3)).toBe("300%");
    expect(formatZoomPercent(10)).toBe("300%");
  });

  it("identifies plain text fence languages", () => {
    expect(isPlainTextLanguage("")).toBe(true);
    expect(isPlainTextLanguage("text")).toBe(true);
    expect(isPlainTextLanguage("TXT")).toBe(true);
    expect(isPlainTextLanguage("plain")).toBe(true);
    expect(isPlainTextLanguage("plaintext")).toBe(true);
    expect(isPlainTextLanguage("typescript")).toBe(false);
    expect(isPlainTextLanguage("bash")).toBe(false);
  });
});
