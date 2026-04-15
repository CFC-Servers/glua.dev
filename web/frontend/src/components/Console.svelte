<script lang="ts">
    import { onDestroy, onMount } from "svelte";
    import { get } from "svelte/store";
    import { mount } from "svelte";
    import { sessionState, scriptMap } from "../lib/stores";
    import { VirtualConsole } from "../lib/virtual-console";
    import { attachMessageHandler } from "../lib/socket";
    import { ReconnectionController } from "../lib/reconnection";
    import StatusPanel from "./StatusPanel.svelte";
    import SessionEndedCard from "./SessionEndedCard.svelte";

    let endedCardShown = false;
    function appendEndedCard(container: HTMLElement) {
        if (endedCardShown) return;
        endedCardShown = true;
        const target = document.createElement("div");
        container.appendChild(target);
        mount(SessionEndedCard, { target });
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                container.scrollTop = container.scrollHeight;
            });
        });
    }

    export let socket: WebSocket | null;
    export let readonlyLogs: string | null = null;

    let commandInput: HTMLInputElement;
    let outputContainer: HTMLDivElement;
    const HISTORY_KEY = "glua-command-history";
    let commandHistory: string[] = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    let historyIndex = -1;

    $: inactive = $sessionState === "closed" || $sessionState === "readonly";

    const MAX_COMMAND_LENGTH = 128;
    const COUNTER_THRESHOLD = Math.floor(MAX_COMMAND_LENGTH * 0.8);
    let commandValue = "";
    $: remaining = MAX_COMMAND_LENGTH - commandValue.length;
    $: showCounter = commandValue.length >= COUNTER_THRESHOLD;
    $: counterColor =
        remaining <= 10 ? "text-red-400" :
        remaining <= 20 ? "text-yellow-400" :
        "text-gray-500";

    let cleanClose = false;
    let virtualConsole: VirtualConsole;
    let reconnection: ReconnectionController;
    let unsubscribeSessionState: (() => void) | null = null;

    onMount(() => {
        virtualConsole = new VirtualConsole(outputContainer);
        reconnection = new ReconnectionController(
            virtualConsole,
            () => socket ? new URL(socket.url).searchParams.get("session") : null,
            () => attemptReconnect(),
        );

        unsubscribeSessionState = sessionState.subscribe((state) => {
            if (state === "closed" && !cleanClose && socket) {
                cleanClose = true;
                commandInput.disabled = true;
                virtualConsole.addLines(["\u001b[31mSession has been closed by the server.\u001b[0m"]);
                appendEndedCard(outputContainer);
                socket.close();
            }
        });

        if (readonlyLogs) {
            renderReadonlySession();
        } else if (socket) {
            setupSocket();
        }
    });

    onDestroy(() => {
        unsubscribeSessionState?.();
        reconnection?.dispose();
    });

    function renderReadonlySession() {
        const lines = readonlyLogs!.split("\n");
        const scripts = get(scriptMap);

        const insertions = Object.entries(scripts)
            .map(([name, entry]) => ({ name, logLine: entry.logLine }))
            .sort((a, b) => a.logLine - b.logLine);

        let insertIdx = 0;
        for (let i = 0; i <= lines.length; i++) {
            while (insertIdx < insertions.length && insertions[insertIdx].logLine <= i) {
                virtualConsole.addScriptLink(insertions[insertIdx].name);
                insertIdx++;
            }
            if (i < lines.length) {
                virtualConsole.addLines([lines[i]]);
            }
        }

        commandInput.disabled = true;
        appendEndedCard(outputContainer);
        outputContainer.scrollTop = outputContainer.scrollHeight;
    }

    function setupSocket() {
        if (!socket) return;

        attachMessageHandler(socket, virtualConsole);

        socket.onopen = () => {
            if (reconnection.handleOpen() === "initial") {
                virtualConsole.addLines(["\u001b[32mConnection established. Waiting for session...\u001b[0m"]);
                sessionState.set("provisioning");
            }
            commandInput.disabled = false;
            commandInput.focus();
        };

        socket.onclose = async (event: CloseEvent) => {
            if (cleanClose || event.code === 1000) {
                reconnection.handleCleanClose();
                virtualConsole.addLines(["\u001b[90mConnection closed.\u001b[0m"]);
                markSessionEnded();
                return;
            }

            const result = await reconnection.handleAbnormalClose();
            if (result === "ended") {
                cleanClose = true;
                markSessionEnded();
            }
        };

        socket.onerror = (err) => {
            if (reconnection.isReconnecting) return;
            console.error("WebSocket error:", err);
            virtualConsole.addLines(["\u001b[31mWebSocket connection error.\u001b[0m"]);
        };
    }

    function markSessionEnded() {
        sessionState.set("closed");
        commandInput.disabled = true;
        appendEndedCard(outputContainer);
    }

    function attemptReconnect() {
        if (!socket || cleanClose || $sessionState === "closed") return;
        const wsUrl = socket.url;
        socket = new WebSocket(wsUrl);
        setupSocket();
    }

    function endSession() {
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "CLOSE_SESSION" }));
        }
    }

    function sendCommand(commandText: string) {
        if (socket?.readyState === WebSocket.OPEN) {
            virtualConsole.addLines([`\u001b[92m> ${commandText}\u001b[0m`]);
            socket.send(JSON.stringify({ type: "COMMAND", payload: commandText }));
        }
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Enter" && commandValue.trim() !== "") {
            const commandText = commandValue.trim();
            sendCommand(commandText);
            commandHistory.unshift(commandText);
            if (commandHistory.length > 50) commandHistory.pop();
            localStorage.setItem(HISTORY_KEY, JSON.stringify(commandHistory));
            historyIndex = -1;
            commandValue = "";
            e.preventDefault();
        } else if (e.key === "ArrowUp") {
            if (historyIndex < commandHistory.length - 1) {
                historyIndex++;
                commandValue = commandHistory[historyIndex];
            }
            e.preventDefault();
        } else if (e.key === "ArrowDown") {
            if (historyIndex >= 0) {
                historyIndex--;
                commandValue = historyIndex >= 0 ? commandHistory[historyIndex] : "";
            }
            e.preventDefault();
        }
    }
</script>

<div id="console-container" class="h-full flex flex-col bg-gray-900 relative">
    <StatusPanel {socket} on:endsession={endSession} />

    <div bind:this={outputContainer} class="flex-grow overflow-y-auto overflow-x-hidden p-4"></div>
    <div class="mt-auto p-4">
        <div class="flex items-center border-t border-gray-700 pt-3">
            <span class="{inactive ? 'text-gray-600' : 'text-green-400'} mr-2 shrink-0">&gt;</span>
            <!-- svelte-ignore a11y-autofocus -->
            <input type="text" bind:this={commandInput} bind:value={commandValue} maxlength={MAX_COMMAND_LENGTH} on:keydown={handleKeydown} class="w-full bg-transparent border-none focus:ring-0 focus:outline-none {inactive ? 'text-gray-600 placeholder-gray-600 cursor-not-allowed' : 'text-gray-200 placeholder-gray-500'}" placeholder="{inactive ? 'Session ended' : 'Enter command...'}" autocomplete="off" autofocus disabled>
            {#if showCounter}
                <span class="ml-2 text-xs font-mono tabular-nums shrink-0 {counterColor}">{remaining}</span>
            {/if}
        </div>
    </div>
</div>
