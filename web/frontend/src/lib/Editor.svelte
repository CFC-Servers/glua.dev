<script lang="ts">
    import { onMount, afterUpdate } from "svelte";
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
    let runScriptButton: HTMLButtonElement;
    let prevEditorState = false;
    let panelWidth = "0px";
    let isResizing = false;

    isEditorOpen.subscribe(open => {
        panelWidth = open ? "33%" : "0px";
    });

    afterUpdate(() => {
        if ($isEditorOpen && !prevEditorState) {
            setTimeout(() => {
                editorView?.dispatch({ effects: EditorView.announce.of("reconfigured") });
                editorView?.focus();
            }, 350);
        }
        prevEditorState = $isEditorOpen;
    });

    const customTheme = EditorView.theme({
        "&": { color: "#d1d5db", backgroundColor: "#1F2937" },
        ".cm-content": { caretColor: "#60a5fa" },
        "&.cm-focused .cm-cursor": { borderLeftColor: "#60a5fa" },
        "&.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "#3b82f680" },
        ".cm-gutters": { backgroundColor: "#1F2937", color: "#6b7280", border: "none" },
        ".cm-keyword": {color: "#c084fc"},
        ".cm-string": {color: "#a5f3fc"},
        ".cm-comment": {color: "#6b7280", fontStyle: "italic"},
        ".cm-number": {color: "#fca5a5"},
        ".cm-variableName": {color: "#d1d5db"},
        ".cm-operator": {color: "#93c5fd"},
        ".cm-function": {color: "#818cf8", fontWeight: "bold"}
    }, {dark: true});

    let value = localStorage.getItem("glua-editor-content") || `--[[...]]`; // Shortened for brevity

    function runScript() {
        if (!editorView || !socket || socket.readyState !== WebSocket.OPEN) return;
        const scriptContent = editorView.state.doc.toString().trim();
        if (scriptContent && !runScriptButton.disabled) {
            socket.send(JSON.stringify({ type: "RUN_SCRIPT", payload: scriptContent }));
            runScriptButton.disabled = true;
            setTimeout(() => { runScriptButton.disabled = false; }, 1000);
        }
    }

    function startResize(e: MouseEvent) {
        e.preventDefault();
        isResizing = true;
        window.addEventListener('mousemove', doResize);
        window.addEventListener('mouseup', stopResize);
    }

    let animationFrameId: number | null = null;
    function doResize(e: MouseEvent) {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        animationFrameId = requestAnimationFrame(() => {
            const newWidth = window.innerWidth - e.clientX;
            if (newWidth > 200 && newWidth < window.innerWidth - 200) {
                panelWidth = `${newWidth}px`;
            }
        });
    }

    function stopResize() {
        isResizing = false;
        window.removeEventListener('mousemove', doResize);
        window.removeEventListener('mouseup', stopResize);
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
    }

    onMount(() => {
        const handleKeydown = (e: KeyboardEvent) => {
            if (e.key === '.' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                isEditorOpen.update(open => !open);
            }
        };
        window.addEventListener('keydown', handleKeydown);
        return () => { window.removeEventListener('keydown', handleKeydown); };
    });
</script>

<div class="relative h-full" style:width={panelWidth} class:resizing={isResizing}>
    <button id="editor-toggle-button" on:click={() => isEditorOpen.update(open => !open)} class:closed={!$isEditorOpen}>
        {#if $isEditorOpen}
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10.293 15.707a1 1 0 010-1.414L14.586 10l-4.293-4.293a1 1 0 111.414-1.414l5 5a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0z" clip-rule="evenodd" /><path fill-rule="evenodd" d="M4.293 15.707a1 1 0 010-1.414L8.586 10 4.293 5.707a1 1 0 011.414-1.414l5 5a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0z" clip-rule="evenodd" /></svg>
        {:else}
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm3 2h6v1H7V5zm0 2h6v1H7V7zm0 2h6v1H7V9zm-1 3a1 1 0 011-1h4a1 1 0 110 2H7a1 1 0 01-1-1z" clip-rule="evenodd" /></svg>
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9.707 4.293a1 1 0 010 1.414L5.414 10l4.293 4.293a1 1 0 01-1.414 1.414l-5-5a1 1 0 010-1.414l5-5a1 1 0 011.414 0z" clip-rule="evenodd" /><path fill-rule="evenodd" d="M15.707 4.293a1 1 0 010 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414l-5-5a1 1 0 010-1.414l5-5a1 1 0 011.414 0z" clip-rule="evenodd" /></svg>
        {/if}
    </button>
    <div id="editor-panel" class:pointer-events-none={!$isEditorOpen}>
        <div on:mousedown={startResize} id="editor-resizer"></div>
        <div id="editor-panel-content">
            <div class="flex-grow relative" id="editor-wrapper">
                <CodeMirror bind:value bind:view={editorView} lang={StreamLanguage.define(lua)} theme={oneDark} extensions={[history(), keymap.of([...defaultKeymap, ...historyKeymap, {key: 'Ctrl-Enter', run: () => { runScript(); return true; }}]), customTheme]} on:change={(e) => localStorage.setItem("glua-editor-content", e.detail.value)} />
                <button bind:this={runScriptButton} on:click={runScript} id="run-script-button" title="Run Script (Ctrl+Enter)">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M9.222 5.934a.5.5 0 00-.722.434v7.264a.5.5 0 00.722.434l6-3.632a.5.5 0 000-.868l-6-3.632z" />
                    </svg>
                    <span>Run</span>
                </button>
            </div>
        </div>
    </div>
</div>