import AnsiUp from "ansi_up";
import { get } from "svelte/store";
import { scriptMap, viewingScript } from "./stores";

/** Scrollable, ANSI-rendered log output backed by a plain div. */
export class VirtualConsole {
  private container: HTMLDivElement;
  private ansiUp: AnsiUp;
  private isAtBottom = true;

  constructor(container: HTMLDivElement) {
    this.container = container;
    this.ansiUp = new AnsiUp();
    this.ansiUp.use_classes = true;

    this.container.addEventListener("scroll", () => {
      const threshold = 5;
      this.isAtBottom =
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < threshold;
    });

    new ResizeObserver(() => {
      if (this.isAtBottom) {
        this.container.scrollTop = this.container.scrollHeight;
      }
    }).observe(this.container);
  }

  addLines(lines: string[]) {
    if (!lines || lines.length === 0) return;
    const wasAtBottom = this.isAtBottom;
    const fragment = document.createDocumentFragment();
    for (const line of lines) {
      const lineDiv = document.createElement("div");
      lineDiv.className = "console-output-line";
      lineDiv.innerHTML = this.ansiUp.ansi_to_html(line);
      fragment.appendChild(lineDiv);
    }
    this.container.appendChild(fragment);
    if (wasAtBottom) {
      this.container.scrollTop = this.container.scrollHeight;
    }
  }

  addScriptLink(name: string) {
    const wasAtBottom = this.isAtBottom;
    const el = document.createElement("div");
    el.className = "console-script-link";

    const icon = document.createElement("span");
    icon.className = "script-icon";
    icon.textContent = "\u25b6";

    const nameSpan = document.createElement("span");
    nameSpan.className = "script-name";
    nameSpan.textContent = name;

    const hint = document.createElement("span");
    hint.className = "script-hint";
    hint.textContent = "\u2014 click to view";

    el.append(icon, nameSpan, hint);
    el.addEventListener("click", () => {
      const entry = get(scriptMap)[name];
      if (entry) {
        viewingScript.set({ name, content: entry.content });
      }
    });
    this.container.appendChild(el);
    if (wasAtBottom) {
      this.container.scrollTop = this.container.scrollHeight;
    }
  }
}
