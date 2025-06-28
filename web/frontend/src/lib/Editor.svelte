<script lang="ts">
    import { onMount } from "svelte";
    import CodeMirror from 'svelte-codemirror-editor';
    import { EditorState } from "@codemirror/state";
    import { EditorView, keymap } from "@codemirror/view";
    import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
    import { StreamLanguage } from "@codemirror/language";
    import { lua } from "./lua-mode.js";
    import { oneDark } from "@codemirror/theme-one-dark";
    import { isEditorOpen } from './stores';

    export let socket: WebSocket | null;

    let editorView: EditorView | null = null;
    let editorPanel: HTMLDivElement;
    let runScriptButton: HTMLButtonElement;

    const customTheme = EditorView.theme({
        "&": {
            color: "#d1d5db",
            backgroundColor: "#1F2937"
        },
        ".cm-content": { caretColor: "#60a5fa" },
        "&.cm-focused .cm-cursor": { borderLeftColor: "#60a5fa" },
        "&.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "#3b82f680" },
        ".cm-gutters": {
            backgroundColor: "#1F2937",
            color: "#6b7280",
            border: "none"
        },
        ".cm-keyword": {color: "#c084fc"},
        ".cm-string": {color: "#a5f3fc"},
        ".cm-comment": {color: "#6b7280", fontStyle: "italic"},
        ".cm-number": {color: "#fca5a5"},
        ".cm-variableName": {color: "#d1d5db"},
        ".cm-operator": {color: "#93c5fd"},
        ".cm-function": {color: "#818cf8", fontWeight: "bold"}
    }, {dark: true});

    let value = localStorage.getItem("glua-editor-content") || "-- Welcome to the GLua Editor!\n\nfunction hello()\n  print(\"Hello from the editor!\")\nend\n\nhello()";

    isEditorOpen.subscribe(open => {
        if (open) {
            setTimeout(() => editorView?.focus(), 300);
        }
    });

    function runScript() {
        if (!editorView || !socket || socket.readyState !== WebSocket.OPEN) return;
        const scriptContent = editorView.state.doc.toString();
        if (scriptContent && !runScriptButton.disabled) {
                socket.send(JSON.stringify({ type: "RUN_SCRIPT", payload: scriptContent }));
                // The console component will display the "Running script..." message
                runScriptButton.disabled = true;
                runScriptButton.textContent = "Running...";
                setTimeout(() => {
                runScriptButton.disabled = false;
                runScriptButton.textContent = "Run Script";
                }, 1000);
        }
    }

    function startResize(e: MouseEvent) {
        e.preventDefault();
        editorPanel.classList.add('resizing');
        window.addEventListener('mousemove', doResize);
        window.addEventListener('mouseup', stopResize);
    }

    function doResize(e: MouseEvent) {
        const newHeight = window.innerHeight - e.clientY;
        if (newHeight > 100 && newHeight < window.innerHeight - 100) {
            editorPanel.style.height = `${newHeight}px`;
        }
    }

    function stopResize() {
        editorPanel.classList.remove('resizing');
        window.removeEventListener('mousemove', doResize);
        window.removeEventListener('mouseup', stopResize);
    }

    onMount(() => {
        const handleKeydown = (e: KeyboardEvent) => {
            if (e.key === '.' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                isEditorOpen.update(open => !open);
            }
        };
        window.addEventListener('keydown', handleKeydown);

        return () => {
            window.removeEventListener('keydown', handleKeydown);
        };
    });
</script>

<div bind:this={editorPanel} id="editor-panel" class="fixed bottom-0 left-0 right-0 bg-gray-800 border-t-2 border-gray-700 shadow-2xl flex flex-col" class:open={$isEditorOpen}>
    <div on:mousedown={startResize} class="w-full h-2 bg-gray-700 hover:bg-indigo-500 transition-colors duration-200 cursor-ns-resize"></div>
    <div class="flex-grow relative">
        <CodeMirror
            bind:value
            bind:view={editorView}
            lang={StreamLanguage.define(lua)}
            theme={oneDark}
            extensions={[
                history(),
                keymap.of([...defaultKeymap, ...historyKeymap]),
                customTheme
            ]}
            on:change={(e) => localStorage.setItem("glua-editor-content", e.detail.value)}
        />
    </div>
    <div class="p-2 bg-gray-900/50 flex justify-end items-center">
            <button bind:this={runScriptButton} on:click={runScript} class="bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-2 px-4 rounded-md transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-indigo-400">
            Run Script
        </button>
    </div>
</div>

<style>
    .open {
        transform: translateY(0);
    }
</style>