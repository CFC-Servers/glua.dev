<script lang="ts">
    import { onMount } from "svelte";
    import CodeMirror from 'svelte-codemirror-editor';
    import { EditorView, keymap } from "@codemirror/view";
    import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
    import { StreamLanguage } from "@codemirror/language";
    import { lua } from "./lua-mode.js";
    import { oneDark } from "@codemirror/theme-one-dark";

    export let socket: WebSocket | null;
    export let fileName: string = "script";

    let runScriptButton: HTMLButtonElement;

    const customTheme = EditorView.theme({
        "&": { color: "#d1d5db", backgroundColor: "#1F2937" },
        ".cm-content": { caretColor: "#60a5fa" },
        "&.cm-focused .cm-cursor": { borderLeftColor: "#60a5fa" },
        "&.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "#3b82f680" },
        ".cm-gutters": { backgroundColor: "#1F2937", color: "#6b7280", border: "none" },
    }, {dark: true});

    let value = `-- Welcome to the GLua Editor!

function hello()
  print("Hello from the editor!")
end

hello()
`;

    onMount(() => {
        const savedContent = localStorage.getItem("glua-editor-content");
        if (savedContent && savedContent !== 'undefined') {
            value = savedContent;
        }
    });

    function runScript() {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        const scriptContent = value.trim();
        if (scriptContent && !runScriptButton.disabled) {
            console.log("Running script:", scriptContent);

            const struct = {
                type: "SCRIPT",
                payload: {
                    name: fileName,
                    content: scriptContent
                }
            };

            socket.send(JSON.stringify(struct));
            runScriptButton.disabled = true;

            // TODO: Send some signal from the server when the script has finished running to re-enable the button
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
                    keymap.of([...defaultKeymap, ...historyKeymap, {key: 'Ctrl-Enter', run: () => { runScript(); return true; }}]),
                    customTheme
                ]} 
                on:change={(e) => localStorage.setItem("glua-editor-content", e.detail.value)} 
            />
        </div>
        <div id="editor-footer">
            <button bind:this={runScriptButton} on:click={runScript} id="run-script-button" title="Run Script (Ctrl+Enter)">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M9.222 5.934a.5.5 0 00-.722.434v7.264a.5.5 0 00.722.434l6-3.632a.5.5 0 000-.868l-6-3.632z" />
                </svg>
                <span>Run</span>
            </button>
        </div>
    </div>
</div>
