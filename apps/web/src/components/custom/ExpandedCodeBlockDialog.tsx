import { T, useGT } from "gt-react";
import { CheckIcon, CopyIcon, MinusIcon, PlusIcon, WrapTextIcon, XIcon } from "lucide-react";
import { Suspense, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { isContextMenuOpen } from "../../contextMenuFallback";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import {
  hasSpecificPierreIconForFileName,
  syntheticFileNameForLanguageId,
} from "../../pierre-icons";
import { composerFloatingLayerProps } from "../chat/composerEventScope";
import { HighlightedTokens } from "../chat/HighlightedTokens";
import { reportMarkdownActionFailure } from "../chat/markdownActionFailure";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
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

interface ExpandedCodeBlockDialogProps {
  readonly code: string;
  readonly language: string;
  readonly fenceTitle: string | null;
  readonly theme: "light" | "dark";
  readonly onClose: () => void;
}

export function ExpandedCodeBlockDialog({
  code,
  language,
  fenceTitle,
  theme,
  onClose,
}: ExpandedCodeBlockDialogProps) {
  const gt = useGT();
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [wrapped, setWrapped] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLPreElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [returnFocus] = useState(() => {
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return { target, focusVisible: target?.matches(":focus-visible") ?? false };
  });

  // The host unmounts this dialog on close, so restore opener focus manually.
  const close = () => {
    flushSync(onClose);
    const { target, focusVisible } = returnFocus;
    if (target?.isConnected) target.focus({ preventScroll: true, focusVisible });
  };

  const { copyToClipboard, isCopied: copied } = useCopyToClipboard({
    timeout: 1200,
    onError: (cause) =>
      reportMarkdownActionFailure(
        {
          operation: "copy-code-block",
          language,
          ...(fenceTitle ? { fenceTitle } : {}),
        },
        cause,
      ),
  });

  const safeZoom = clampZoom(zoom);
  const displayCode = code.endsWith("\n") ? code.slice(0, -1) : code;
  const plainText = isPlainTextLanguage(language);
  const wrapLabel = wrapped ? gt("Disable line wrap") : gt("Wrap lines");
  const copyLabel = copied ? gt("Copied") : gt("Copy code");
  const languageFileName = syntheticFileNameForLanguageId(language);
  const hasLanguageIcon = !fenceTitle && hasSpecificPierreIconForFileName(languageFileName);

  const attachViewport = (viewport: HTMLDivElement) => {
    viewportRef.current = viewport;
    // React's onWheel is passive and cannot stop browser page zoom on Cmd/Ctrl+wheel.
    const handleWheel = (event: WheelEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return;
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      setZoom((current) => applyWheelZoom(current, delta));
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", handleWheel);
      viewportRef.current = null;
    };
  };

  const handleFitToWidth = () => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    if (wrapped) {
      flushSync(() => setWrapped(false));
    }
    const styles = getComputedStyle(viewport);
    const horizontalPadding =
      (Number.parseFloat(styles.paddingLeft) || 0) + (Number.parseFloat(styles.paddingRight) || 0);
    const availableWidth = viewport.clientWidth - horizontalPadding;
    const measuredWidth = content.getBoundingClientRect().width;
    if (availableWidth <= 0 || measuredWidth <= 0) return;
    const naturalWidth = measuredWidth / safeZoom;
    setZoom(calculateFitZoom(availableWidth, naturalWidth));
  };

  const handleCopy = () => copyToClipboard(displayCode);

  return (
    <Dialog
      open
      onOpenChange={(open, eventDetails) => {
        if (open) return;
        if (eventDetails.reason === "escape-key" && isContextMenuOpen()) {
          eventDetails.cancel();
          return;
        }
        close();
      }}
    >
      <DialogPopup
        {...composerFloatingLayerProps}
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="h-[90vh] max-h-[90vh] w-[94vw] max-w-[94vw] overflow-hidden"
        initialFocus={closeButtonRef}
        finalFocus={() => returnFocus.target}
      >
        <DialogTitle className="sr-only">
          {fenceTitle
            ? gt("Expanded code block: {title}", { title: fenceTitle })
            : gt("Expanded {language} code block", { language })}
        </DialogTitle>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border/70 bg-secondary/60 px-3 py-2 select-none dark:bg-input/32">
          <div className="flex min-w-32 flex-1 items-center gap-2 font-mono text-xs text-foreground">
            {fenceTitle ? (
              <>
                <PierreEntryIcon
                  pathValue={fenceTitle}
                  kind="file"
                  theme={theme}
                  className="size-3.5 shrink-0"
                />
                <span className="truncate">{fenceTitle}</span>
                {language ? (
                  <span className="shrink-0 text-2xs text-muted-foreground">{language}</span>
                ) : null}
              </>
            ) : (
              <>
                {hasLanguageIcon ? (
                  <PierreEntryIcon
                    pathValue={languageFileName}
                    kind="file"
                    theme={theme}
                    className="size-3.5 shrink-0"
                  />
                ) : null}
                <span className="truncate">{language || "text"}</span>
              </>
            )}
          </div>
          <div
            className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5"
            role="toolbar"
            aria-label={gt("Code block viewer controls")}
          >
            <div className="flex items-center gap-0.5 rounded-md border border-border/70 bg-background/70 p-0.5">
              <SharedTooltipTrigger
                label={gt("Zoom out")}
                render={
                  <Button
                    type="button"
                    variant="ghost-muted"
                    size="icon-xs"
                    disabled={safeZoom <= MIN_ZOOM}
                    onClick={() => setZoom((current) => stepZoom(current, -1))}
                    aria-label={gt("Zoom out")}
                  />
                }
              >
                <MinusIcon className="size-3" />
              </SharedTooltipTrigger>
              <span
                className="min-w-11 px-1 text-center font-mono text-xs tabular-nums text-foreground"
                aria-live="polite"
                data-slot="codeblock-zoom-percent"
              >
                {formatZoomPercent(safeZoom)}
              </span>
              <SharedTooltipTrigger
                label={gt("Zoom in")}
                render={
                  <Button
                    type="button"
                    variant="ghost-muted"
                    size="icon-xs"
                    disabled={safeZoom >= MAX_ZOOM}
                    onClick={() => setZoom((current) => stepZoom(current, 1))}
                    aria-label={gt("Zoom in")}
                  />
                }
              >
                <PlusIcon className="size-3" />
              </SharedTooltipTrigger>
              <SharedTooltipTrigger
                label={gt("Reset zoom")}
                render={
                  <Button
                    type="button"
                    variant={safeZoom === DEFAULT_ZOOM ? "secondary" : "ghost-muted"}
                    size="xs"
                    onClick={() => setZoom(DEFAULT_ZOOM)}
                    aria-label={gt("Reset zoom")}
                  />
                }
              >
                100%
              </SharedTooltipTrigger>
              <SharedTooltipTrigger
                label={gt("Fit to width")}
                render={
                  <Button
                    type="button"
                    variant="ghost-muted"
                    size="xs"
                    onClick={handleFitToWidth}
                    aria-label={gt("Fit to width")}
                  />
                }
              >
                <T context="verb, scales code block to fit viewport width">Fit</T>
              </SharedTooltipTrigger>
            </div>
            <SharedTooltipTrigger
              label={wrapLabel}
              render={
                <Button
                  type="button"
                  variant={wrapped ? "secondary" : "ghost-muted"}
                  size="icon-xs"
                  aria-pressed={wrapped}
                  onClick={() => setWrapped((current) => !current)}
                  aria-label={wrapLabel}
                />
              }
            >
              <WrapTextIcon className="size-3.5" />
            </SharedTooltipTrigger>
            <SharedTooltipTrigger
              label={copyLabel}
              render={
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="icon-xs"
                  onClick={handleCopy}
                  aria-label={copyLabel}
                />
              }
            >
              {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            </SharedTooltipTrigger>
            <Button
              ref={closeButtonRef}
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              onClick={close}
              aria-label={gt("Close", { $context: "button, closes the dialog" })}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        </div>
        <div
          ref={attachViewport}
          dir="ltr"
          data-slot="codeblock-viewport"
          data-wrap={wrapped ? "true" : "false"}
          className="min-h-0 flex-1 overflow-auto overscroll-contain bg-background p-4 text-start text-foreground"
        >
          <pre
            ref={contentRef}
            className={cn(
              "m-0 font-mono leading-relaxed select-text",
              wrapped ? "w-full whitespace-pre-wrap wrap-anywhere" : "w-max whitespace-pre",
            )}
            style={{ fontSize: `calc(var(--font-size-code, 0.875rem) * ${safeZoom})` }}
          >
            <code className="font-mono">
              {plainText ? (
                displayCode
              ) : (
                <RenderErrorBoundary
                  resetKeys={[displayCode, language, theme]}
                  fallback={displayCode}
                >
                  <Suspense fallback={displayCode}>
                    <HighlightedTokens code={displayCode} language={language} theme={theme} />
                  </Suspense>
                </RenderErrorBoundary>
              )}
            </code>
          </pre>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
