<script lang="ts">
  import { onMount, afterUpdate } from "svelte";
  import Modal from "./lib/Modal.svelte";
  import Console from "./lib/Console.svelte";
  import Editor from "./lib/Editor.svelte";
  import { isEditorOpen } from "./lib/stores";

  let session = { id: null, type: null };
  let socket: WebSocket | null = null;
  let showModal = true;
  let editorPanel: HTMLElement;
  let consolePanel: HTMLElement;
  let resizing = false;

  const EDITOR_WIDTH_KEY = 'glua-editor-width';
  const EDITOR_OPEN_KEY = 'glua-editor-open';

  function updatePanelWidths() {
    if (consolePanel && !resizing) {
      if ($isEditorOpen) {
        const savedWidth = localStorage.getItem(EDITOR_WIDTH_KEY) || '33%';
        const consoleWidth = `calc(100% - ${savedWidth})`;
        consolePanel.style.width = consoleWidth;
        if(editorPanel) editorPanel.style.width = savedWidth;
      } else {
        consolePanel.style.width = '100%';
      }
    }
  }

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session");
    const sessionType = params.get("type");
    if (sessionId && sessionType) {
      connectWebSocket(sessionId, sessionType);
    }

    const editorOpen = localStorage.getItem(EDITOR_OPEN_KEY);
    isEditorOpen.set(editorOpen ? JSON.parse(editorOpen) : false);

    const handleKeydown = (e: KeyboardEvent) => {
        if (e.key === '.' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            isEditorOpen.update(open => !open);
        }
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  afterUpdate(() => {
    updatePanelWidths();
  });

  isEditorOpen.subscribe(open => {
    localStorage.setItem(EDITOR_OPEN_KEY, JSON.stringify(open));
  });

  function connectWebSocket(sessionId: string, sessionType: string) {
    session.id = sessionId;
    session.type = sessionType;
    updateUrl();
    showModal = false;
    const wsScheme = window.location.protocol === "https:" ? "wss://" : "ws://";
    const wsUrl = `${wsScheme}${window.location.host}/ws/browser?session=${sessionId}&type=${sessionType}`;
    socket = new WebSocket(wsUrl);
  }

  function updateUrl() {
    if (!session.id || !session.type) return;
    const url = new URL(window.location);
    url.searchParams.set("session", session.id);
    url.searchParams.set("type", session.type);
    window.history.pushState({ ...session }, "", url);
  }

  function handleMouseDown(e: MouseEvent) {
    e.preventDefault();
    resizing = true;

    const handleMouseMove = (e: MouseEvent) => {
      const editorWidth = window.innerWidth - e.clientX;

      if (editorWidth > 200 && editorWidth < window.innerWidth - 200) {
        if (editorPanel) editorPanel.style.width = `${editorWidth}px`;
        if (consolePanel) consolePanel.style.width = `${e.clientX}px`;
      }
    };

    const handleMouseUp = () => {
      resizing = false;
      if (editorPanel) {
        localStorage.setItem(EDITOR_WIDTH_KEY, editorPanel.style.width);
      }
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      updatePanelWidths();
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }
</script>

<main class="flex flex-row h-screen overflow-hidden">
  {#if showModal}
    <Modal on:startsession={(e) => connectWebSocket(e.detail.sessionId, e.detail.sessionType)} />
  {:else}
    <div bind:this={consolePanel} class="h-full relative">
      <Console {socket} />
      <button id="editor-toggle-button" on:click={() => isEditorOpen.update(open => !open)} title="Toggle Editor (Ctrl+.)">
        {#if $isEditorOpen}
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10.293 15.707a1 1 0 010-1.414L14.586 10l-4.293-4.293a1 1 0 111.414-1.414l5 5a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0z" clip-rule="evenodd" />
            <path fill-rule="evenodd" d="M4.293 15.707a1 1 0 010-1.414L8.586 10 4.293 5.707a1 1 0 011.414-1.414l5 5a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0z" clip-rule="evenodd" />
          </svg>
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M9.707 4.293a1 1 0 010 1.414L5.414 10l4.293 4.293a1 1 0 01-1.414 1.414l-5-5a1 1 0 010-1.414l5-5a1 1 0 011.414 0z" clip-rule="evenodd" />
            <path fill-rule="evenodd" d="M15.707 4.293a1 1 0 010 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414l-5-5a1 1 0 010-1.414l5-5a1 1 0 011.414 0z" clip-rule="evenodd" />
          </svg>
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm3 2h6v1H7V5zm0 2h6v1H7V7zm0 2h6v1H7V9zm-1 3a1 1 0 011-1h4a1 1 0 110 2H7a1 1 0 01-1-1z" clip-rule="evenodd" />
          </svg>
        {/if}
      </button>
    </div>
    {#if $isEditorOpen}
      <div id="resizer" on:mousedown={handleMouseDown}></div>
      <div bind:this={editorPanel} class="h-full" style="width: 33%;">
        <Editor {socket} />
      </div>
    {/if}
  {/if}
</main>



