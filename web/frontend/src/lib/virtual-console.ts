import AnsiUp from "ansi_up";
import { mount } from "svelte";
import { get } from "svelte/store";
import SystemNotice from "../components/SystemNotice.svelte";
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

  addSpinnerLine(initialText: string): { update: (text: string) => void; finalize: (text: string) => void; remove: () => void } {
    const wasAtBottom = this.isAtBottom;
    const lineDiv = document.createElement("div");
    lineDiv.className = "console-output-line console-spinner-line";

    const spinnerSpan = document.createElement("span");
    spinnerSpan.className = "console-spinner";

    const textSpan = document.createElement("span");
    textSpan.innerHTML = this.ansiUp.ansi_to_html(initialText);

    lineDiv.append(spinnerSpan, " ", textSpan);
    this.container.appendChild(lineDiv);
    if (wasAtBottom) this.container.scrollTop = this.container.scrollHeight;

    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frameIndex = 0;
    spinnerSpan.textContent = frames[0];
    const interval = setInterval(() => {
      frameIndex = (frameIndex + 1) % frames.length;
      spinnerSpan.textContent = frames[frameIndex];
    }, 80);

    return {
      update: (text: string) => {
        textSpan.innerHTML = this.ansiUp.ansi_to_html(text);
      },
      finalize: (text: string) => {
        clearInterval(interval);
        spinnerSpan.remove();
        textSpan.innerHTML = this.ansiUp.ansi_to_html(text);
      },
      remove: () => {
        clearInterval(interval);
        lineDiv.remove();
      },
    };
  }

  mountSystemNotice(message: string) {
    const wasAtBottom = this.isAtBottom;
    const target = document.createElement("div");
    this.container.appendChild(target);
    mount(SystemNotice, { target, props: { message } });
    if (wasAtBottom) {
      requestAnimationFrame(() => {
        this.container.scrollTop = this.container.scrollHeight;
      });
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
