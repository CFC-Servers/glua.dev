<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./lib/Modal.svelte";
  import Console from "./lib/Console.svelte";
  import Editor from "./lib/Editor.svelte";

  let session = { id: null, type: null };
  let socket: WebSocket | null = null;
  let showModal = true;

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session");
    const sessionType = params.get("type");
    if (sessionId && sessionType) {
      connectWebSocket(sessionId, sessionType);
    }
  });

  function connectWebSocket(sessionId: string, sessionType: string) {
    session.id = sessionId;
    session.type = sessionType;
    updateUrl();

    showModal = false;

    const wsScheme = window.location.protocol === "https:" ? "wss://" : "ws://";
    const wsUrl = `${wsScheme}${window.location.host}/ws/browser?session=${sessionId}&type=${sessionType}`;
    
    socket = new WebSocket(wsUrl);
    // WebSocket event handlers will be added here
  }

  function updateUrl() {
    if (!session.id || !session.type) return;
    const url = new URL(window.location);
    url.searchParams.set("session", session.id);
    url.searchParams.set("type", session.type);
    window.history.pushState({ ...session }, "", url);
  }
</script>

<main class="flex flex-row h-screen">
  {#if showModal}
    <Modal on:startsession={(e) => connectWebSocket(e.detail.sessionId, e.detail.sessionType)} />
  {:else}
    <div class="flex-grow">
      <Console {socket} />
    </div>
    <Editor {socket} />
  {/if}
</main>
