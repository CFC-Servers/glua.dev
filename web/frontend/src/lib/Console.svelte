<script lang="ts">
    import { onMount } from "svelte";
    import StatusPanel from "./StatusPanel.svelte";

    export let socket: WebSocket | null;

    let commandInput: HTMLInputElement;
    let outputContainer: HTMLDivElement;
    let commandHistory: string[] = [];
    let historyIndex = -1;

    class VirtualConsole {
        private container: HTMLDivElement;
        private ansiUp: any;
        private isAtBottom = true;

        constructor(container: HTMLDivElement) {
            this.container = container;
            this.ansiUp = new (window as any).AnsiUp();
            this.container.addEventListener('scroll', () => {
                const threshold = 5;
                this.isAtBottom = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < threshold;
            });
        }

        addLines(lines: string[]) {
            if (!lines || lines.length === 0) return;
            const wasAtBottom = this.isAtBottom;
            const fragment = document.createDocumentFragment();
            for (const line of lines) {
                const lineDiv = document.createElement('div');
                lineDiv.className = 'console-output-line';
                lineDiv.innerHTML = this.ansiUp.ansi_to_html(line);
                fragment.appendChild(lineDiv);
            }
            this.container.appendChild(fragment);
            if (wasAtBottom) {
                this.container.scrollTop = this.container.scrollHeight;
            }
        }
    }

    let virtualConsole: VirtualConsole;

    onMount(() => {
        virtualConsole = new VirtualConsole(outputContainer);
        if (socket) {
            setupWebSocketHandlers();
        }
    });

    function setupWebSocketHandlers() {
        if (!socket) return;

        socket.onopen = () => {
            virtualConsole.addLines(["\u001b[32mConnection established. Waiting for session...\u001b[0m"]);
            commandInput.disabled = false;
            commandInput.focus();
        };

        socket.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                switch (msg.type) {
                    case "HISTORY":
                        virtualConsole.addLines(msg.payload.split('\n'));
                        break;
                    case "LOGS":
                        virtualConsole.addLines(Array.isArray(msg.payload) ? msg.payload : [msg.payload]);
                        break;
                    case "HEALTH":
                        // This will be handled by the StatusPanel component
                        break;
                    case "SESSION_TIMER":
                        // This will be handled by the StatusPanel component
                        break;
                    case "SESSION_CLOSED":
                        virtualConsole.addLines(["\u001b[31mSession has been closed by the server.\u001b[0m"]);
                        commandInput.disabled = true;
                        socket?.close();
                        break;
                    case "CONTEXT_UPDATE":
                        // This will be handled by the StatusPanel component
                        break;
                }
            } catch (e) { console.error("Failed to process message", e); }
        };

        socket.onclose = () => {
            virtualConsole.addLines(["\u001b[90mConnection closed.\u001b[0m"]);
            commandInput.disabled = true;
        };

        socket.onerror = (err) => {
            console.error("WebSocket Error:", err);
            virtualConsole.addLines(["\u001b[31mWebSocket connection error.\u001b[0m"]);
        };
    }

    function sendCommand(commandText: string) {
        if (socket?.readyState === WebSocket.OPEN) {
            virtualConsole.addLines([`\u001b[92m> ${commandText}\u001b[0m`]);
            socket.send(JSON.stringify({ type: "COMMAND", payload: commandText }));
        }
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Enter" && commandInput.value.trim() !== "") {
            const commandText = commandInput.value.trim();
            sendCommand(commandText);
            commandHistory.unshift(commandText);
            if (commandHistory.length > 50) commandHistory.pop();
            historyIndex = -1;
            commandInput.value = "";
            e.preventDefault();
        } else if (e.key === "ArrowUp") {
            if (historyIndex < commandHistory.length - 1) {
                historyIndex++;
                commandInput.value = commandHistory[historyIndex];
            }
            e.preventDefault();
        } else if (e.key === "ArrowDown") {
            if (historyIndex >= 0) {
                historyIndex--;
                if (historyIndex >= 0) {
                    commandInput.value = commandHistory[historyIndex];
                } else {
                    commandInput.value = "";
                }
            }
            e.preventDefault();
        }
    }
</script>

<div id="console-container" class="h-full flex flex-col bg-gray-900 relative">
    <StatusPanel {socket} />
    
    <div bind:this={outputContainer} class="flex-grow overflow-y-auto overflow-x-hidden p-4"></div>
    <div class="mt-auto p-4">
        <div class="flex items-center border-t border-gray-700 pt-3">
            <span class="text-green-400 mr-2 shrink-0">&gt;</span>
            <input type="text" bind:this={commandInput} on:keydown={handleKeydown} class="w-full bg-transparent border-none focus:ring-0 focus:outline-none text-gray-200 placeholder-gray-500" placeholder="Enter command..." autocomplete="off" autofocus disabled>
        </div>
    </div>
</div>
