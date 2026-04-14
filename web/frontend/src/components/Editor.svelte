<script lang="ts">
    import CodeMirror from "svelte-codemirror-editor";
    import { EditorView, keymap } from "@codemirror/view";
    import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
    import { StreamLanguage } from "@codemirror/language";
    import { lua } from "../lib/lua-mode";
    import { oneDark } from "@codemirror/theme-one-dark";
    import { gluaTheme } from "../lib/editor-theme";
    import { sessionState } from "../lib/stores";

    export let socket: WebSocket | null;
    export let fileName: string = "script";

    let runScriptButton: HTMLButtonElement;

    $: inactive = $sessionState === "closed" || $sessionState === "readonly";

    const STORAGE_KEY = "glua-editor-content";
    const DEFAULT_CONTENT = `-- Welcome to the GLua Editor!

function hello()
  print("Hello from the editor!")
end

hello()
`;

    // Read synchronously so CodeMirror sees the correct initial value on mount.
    // Doing this in onMount races with CodeMirror's own init and can also let
    // the editor's first on:change overwrite localStorage with the default
    function loadInitialContent(): string {
        const saved = localStorage.getItem(STORAGE_KEY);
        return saved && saved !== "undefined" ? saved : DEFAULT_CONTENT;
    }

    let value = loadInitialContent();

    // Driven by the bound `value` rather than CodeMirror's on:change event,
    // which can fire with a transient empty string during init and wipe the
    // saved script before the user ever types
    $: if (typeof value === "string") localStorage.setItem(STORAGE_KEY, value);

    function runScript() {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        const scriptContent = value.trim();
        if (scriptContent && !runScriptButton.disabled) {
            socket.send(JSON.stringify({
                type: "SCRIPT",
                payload: { name: fileName, content: scriptContent },
            }));
            runScriptButton.disabled = true;
            // TODO: re-enable when server confirms execution instead of a fixed timeout
            setTimeout(() => { runScriptButton.disabled = false; }, 1000);
        }
    }
</script>

<div id="editor-panel" class="h-full w-full">
    <div id="editor-wrapper">
        <div id="editor-container">
            <CodeMirror
                bind:value
                lang={StreamLanguage.define(lua)}
                theme={oneDark}
                extensions={[
                    history(),
                    keymap.of([
                        { key: "Mod-Enter", run: () => { runScript(); return true; } },
                        ...defaultKeymap,
                        ...historyKeymap,
                    ]),
                    EditorView.domEventHandlers({
                        mousedown(event, view) {
                            const contentBottom = view.contentDOM.getBoundingClientRect().bottom;
                            if (event.clientY > contentBottom) {
                                view.dispatch({ selection: { anchor: view.state.doc.length } });
                                view.focus();
                                event.preventDefault();
                                return true;
                            }
                            return false;
                        },
                    }),
                    gluaTheme,
                ]}
            />
        </div>
        <div id="editor-footer">
            <button bind:this={runScriptButton} on:click={runScript} id="run-script-button" class="{inactive ? 'session-ended' : ''}" title="{inactive ? 'Session ended' : 'Run Script (⌘/Ctrl+Enter)'}" disabled={inactive}>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M9.222 5.934a.5.5 0 00-.722.434v7.264a.5.5 0 00.722.434l6-3.632a.5.5 0 000-.868l-6-3.632z" />
                </svg>
                <span>{inactive ? "Session Ended" : "Run"}</span>
            </button>
        </div>
    </div>
</div>
