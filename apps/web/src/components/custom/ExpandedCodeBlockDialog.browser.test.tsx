import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { ensureClientSettingsHydrated, persistClientSettingsPatch } from "../../hooks/useSettings";
import { MarkdownCodeBlock } from "../chat/MarkdownCodeBlock";

const setWordWrap = (wordWrap: boolean) =>
  act(() => persistClientSettingsPatch({ wordWrap }, async () => {}));

const WIDE_DIAGRAM = `${"+" + "-".repeat(138) + "+"}\n| ${"ASCII DIAGRAM NODE ".repeat(6).padEnd(136)} |\n${"+" + "-".repeat(138) + "+"}\n`;

function renderWideCodeBlock() {
  return render(
    <MarkdownCodeBlock
      code={WIDE_DIAGRAM}
      language="text"
      fenceTitle="diagram.txt"
      theme="light"
      isStreaming={false}
    >
      <pre>
        <code>{WIDE_DIAGRAM}</code>
      </pre>
    </MarkdownCodeBlock>,
    { router: false }, // The code block reads no route state.
  );
}

describe("ExpandedCodeBlockDialog", () => {
  it("opens from the Expand button with line wrap defaulted to off", async () => {
    await ensureClientSettingsHydrated();
    await setWordWrap(true);
    await using screen = await renderWideCodeBlock();

    await userEvent.click(screen.getByRole("button", { name: "Expand code block" }));
    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByText("diagram.txt")).toBeVisible();
    await expect
      .element(dialog.getByRole("button", { name: "Wrap lines" }))
      .toHaveAttribute("aria-pressed", "false");

    const dialogEl = dialog.element();
    const viewport = dialogEl.querySelector<HTMLElement>('[data-slot="codeblock-viewport"]');
    const pre = dialogEl.querySelector<HTMLElement>("pre");
    expect(viewport?.getAttribute("data-wrap")).toBe("false");
    expect(pre).not.toBeNull();
    expect(getComputedStyle(pre!).whiteSpace).toBe("pre");
  });

  it("updates scale via zoom buttons, 100%, Fit, and Ctrl+wheel", async () => {
    await ensureClientSettingsHydrated();
    await page.viewport(1000, 700);
    await using screen = await renderWideCodeBlock();

    await userEvent.click(screen.getByRole("button", { name: "Expand code block" }));
    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();

    const dialogEl = dialog.element();
    const zoomReadout = dialogEl.querySelector<HTMLElement>(
      '[data-slot="codeblock-zoom-percent"]',
    )!;
    const viewport = dialogEl.querySelector<HTMLElement>('[data-slot="codeblock-viewport"]')!;
    const pre = dialogEl.querySelector<HTMLElement>("pre")!;
    const baseFontSize = Number.parseFloat(getComputedStyle(pre).fontSize);
    expect(zoomReadout.textContent).toBe("100%");

    await userEvent.click(dialog.getByRole("button", { name: "Zoom in" }));
    expect(zoomReadout.textContent).toBe("125%");
    expect(Number.parseFloat(getComputedStyle(pre).fontSize)).toBeGreaterThan(baseFontSize);

    await userEvent.click(dialog.getByRole("button", { name: "Zoom out" }));
    await userEvent.click(dialog.getByRole("button", { name: "Zoom out" }));
    expect(zoomReadout.textContent).toBe("75%");
    expect(Number.parseFloat(getComputedStyle(pre).fontSize)).toBeLessThan(baseFontSize);

    await userEvent.click(dialog.getByRole("button", { name: "Reset zoom" }));
    expect(zoomReadout.textContent).toBe("100%");
    expect(Number.parseFloat(getComputedStyle(pre).fontSize)).toBeCloseTo(baseFontSize, 1);

    await userEvent.click(dialog.getByRole("button", { name: "Fit to width" }));
    const fitPercent = Number.parseInt(zoomReadout.textContent ?? "", 10);
    expect(fitPercent).toBeLessThan(100);
    expect(fitPercent).toBeGreaterThanOrEqual(50);
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);

    const beforeWheelPercent = fitPercent;
    const viewportLocator = page.elementLocator(viewport);
    await userEvent.keyboard("{Control>}");
    await userEvent.wheel(viewportLocator, { delta: { y: -120 } });
    await userEvent.keyboard("{/Control}");
    await vi.waitFor(() => {
      const afterWheelPercent = Number.parseInt(zoomReadout.textContent ?? "", 10);
      expect(afterWheelPercent).toBeGreaterThan(beforeWheelPercent);
    });
  });

  it("toggles line wrap, copies code cleanly, and restores focus on close", async () => {
    await ensureClientSettingsHydrated();
    await using screen = await renderWideCodeBlock();

    const expandButton = screen.getByRole("button", { name: "Expand code block" });
    await userEvent.click(expandButton);
    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();

    const dialogEl = dialog.element();
    const viewport = dialogEl.querySelector<HTMLElement>('[data-slot="codeblock-viewport"]')!;
    const pre = dialogEl.querySelector<HTMLElement>("pre")!;

    await userEvent.click(dialog.getByRole("button", { name: "Wrap lines" }));
    await expect
      .element(dialog.getByRole("button", { name: "Disable line wrap" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(viewport.getAttribute("data-wrap")).toBe("true");
    expect(getComputedStyle(pre).whiteSpace).toBe("pre-wrap");

    await userEvent.click(dialog.getByRole("button", { name: "Disable line wrap" }));
    await expect
      .element(dialog.getByRole("button", { name: "Wrap lines" }))
      .toHaveAttribute("aria-pressed", "false");
    expect(viewport.getAttribute("data-wrap")).toBe("false");
    expect(getComputedStyle(pre).whiteSpace).toBe("pre");

    using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await userEvent.click(dialog.getByRole("button", { name: "Copy code" }));
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(WIDE_DIAGRAM.slice(0, -1)));
    await expect.element(dialog.getByRole("button", { name: "Copied" })).toBeVisible();

    await userEvent.click(dialog.getByRole("button", { name: "Close" }));
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(expandButton).toHaveFocus();

    await userEvent.click(expandButton);
    await expect.element(dialog).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(expandButton).toHaveFocus();
  });

  it("omits the Expand button for diagrams and blank code blocks", async () => {
    await ensureClientSettingsHydrated();
    await using diagramScreen = await render(
      <MarkdownCodeBlock
        code={"graph TD\nA-->B\n"}
        language="mermaid"
        fenceTitle={null}
        theme="light"
        isStreaming={false}
        diagram
      >
        <div>diagram</div>
      </MarkdownCodeBlock>,
      { router: false }, // The code block reads no route state.
    );
    await expect
      .element(diagramScreen.getByRole("button", { name: "Expand code block" }))
      .not.toBeInTheDocument();

    await using emptyScreen = await render(
      <MarkdownCodeBlock
        code={"   \n"}
        language="text"
        fenceTitle={null}
        theme="light"
        isStreaming={false}
      >
        <pre>
          <code>{"   \n"}</code>
        </pre>
      </MarkdownCodeBlock>,
      { router: false }, // The code block reads no route state.
    );
    await expect
      .element(emptyScreen.getByRole("button", { name: "Expand code block" }))
      .not.toBeInTheDocument();
  });
});
