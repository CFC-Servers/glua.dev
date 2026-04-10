<script lang="ts">
    import CodeMirror from "svelte-codemirror-editor";
    import { EditorView } from "@codemirror/view";
    import { EditorState } from "@codemirror/state";
    import { StreamLanguage } from "@codemirror/language";
    import { lua } from "./lua-mode.js";
    import { oneDark } from "@codemirror/theme-one-dark";
    import { viewingScript } from "./stores";

    const customTheme = EditorView.theme({
        "&": { color: "#d1d5db", backgroundColor: "#1F2937" },
        ".cm-content": { caretColor: "#60a5fa" },
        "&.cm-focused .cm-cursor": { borderLeftColor: "#60a5fa" },
        "&.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "#3b82f680" },
        ".cm-gutters": { backgroundColor: "#1F2937", color: "#6b7280", border: "none" },
    }, {dark: true});

    function close() {
        viewingScript.set(null);
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Escape") {
            close();
        }
    }

    function handleBackdropClick(e: MouseEvent) {
        if (e.target === e.currentTarget) {
            close();
        }
    }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if $viewingScript}
    <div class="fixed inset-0 bg-gray-900 bg-opacity-80 flex items-center justify-center z-[60]" on:click={handleBackdropClick} on:keydown={handleKeydown} role="dialog" aria-modal="true" aria-label="Script viewer" tabindex="-1">
        <div class="bg-gray-800 rounded-lg shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col border border-gray-700/50">
            <div class="flex justify-between items-center px-4 py-3 border-b border-gray-700">
                <span class="font-mono text-sm text-indigo-400">{$viewingScript.name}</span>
                <button on:click={close} class="text-gray-400 hover:text-white transition-colors" aria-label="Close script viewer">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
                    </svg>
                </button>
            </div>
            <div class="flex-1 overflow-auto">
                <CodeMirror
                    value={$viewingScript.content}
                    lang={StreamLanguage.define(lua)}
                    theme={oneDark}
                    extensions={[customTheme, EditorState.readOnly.of(true)]}
                />
            </div>
        </div>
    </div>
{/if}
