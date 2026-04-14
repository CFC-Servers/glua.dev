<script lang="ts">
    import { onMount } from "svelte";
    import CodeMirror from "svelte-codemirror-editor";
    import { keymap } from "@codemirror/view";
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

    let value = `-- Welcome to the GLua Editor!

function hello()
  print("Hello from the editor!")
end

hello()
`;

    onMount(() => {
        const savedContent = localStorage.getItem("glua-editor-content");
        if (savedContent && savedContent !== "undefined") {
            value = savedContent;
        }
    });

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
                    keymap.of([...defaultKeymap, ...historyKeymap, {key: "Ctrl-Enter", run: () => { runScript(); return true; }}]),
                    gluaTheme
                ]}
                on:change={(e) => localStorage.setItem("glua-editor-content", e.detail.value)}
            />
        </div>
        <div id="editor-footer">
            <button bind:this={runScriptButton} on:click={runScript} id="run-script-button" class="{inactive ? 'session-ended' : ''}" title="{inactive ? 'Session ended' : 'Run Script (Ctrl+Enter)'}" disabled={inactive}>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M9.222 5.934a.5.5 0 00-.722.434v7.264a.5.5 0 00.722.434l6-3.632a.5.5 0 000-.868l-6-3.632z" />
                </svg>
                <span>{inactive ? "Session Ended" : "Run"}</span>
            </button>
        </div>
    </div>
</div>
