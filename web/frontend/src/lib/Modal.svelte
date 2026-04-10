<script lang="ts">
    import { createEventDispatcher } from "svelte";

    const dispatch = createEventDispatcher();

    let containerType = "public";
    let inQueue = false;
    let queuePosition = "...";

    // Advanced options
    let showAdvanced = false;
    let map = "gm_construct";
    let gamemode = "sandbox";
    let gitRepos: string[] = [];
    let repoError = "";

    function addRepo() {
        if (gitRepos.length >= 5) return;
        gitRepos = [...gitRepos, ""];
    }

    function removeRepo(index: number) {
        gitRepos = gitRepos.filter((_, i) => i !== index);
    }

    function updateRepo(index: number, value: string) {
        gitRepos[index] = value;
        gitRepos = gitRepos;
    }

    function buildOptions() {
        return {
            map,
            gamemode,
            gitRepos: gitRepos.filter(r => r.trim() !== ""),
        };
    }

    let sessionError = "";

    function validateRepos(): boolean {
        const filled = gitRepos.filter(r => r.trim() !== "");
        for (const repo of filled) {
            try {
                if (new URL(repo).hostname !== "github.com") {
                    repoError = "Only GitHub repos are supported";
                    return false;
                }
            } catch {
                repoError = "Invalid URL";
                return false;
            }
        }
        repoError = "";
        return true;
    }

    async function requestSession() {
        if (!validateRepos()) return;
        sessionError = "";
        inQueue = true;
        queuePosition = "Connecting...";

        try {
            const response = await fetch("/api/request-session", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: containerType, options: buildOptions() }),
            });
            const data = await response.json();

            if (data.status === "READY") {
                dispatch("startsession", { sessionId: data.sessionId, sessionType: containerType });
            } else if (data.status === "QUEUED") {
                queuePosition = data.position;
                pollQueueStatus(data.ticketId);
            } else if (data.status === "ERROR") {
                sessionError = data.error || "Failed to create session";
                inQueue = false;
            }
        } catch (e) {
            console.error("Failed to request session:", e);
            inQueue = false;
        }
    }

    function pollQueueStatus(ticketId: string) {
        const poll = async () => {
            try {
                const response = await fetch(`/api/queue-status?ticketId=${ticketId}`);
                const data = await response.json();

                if(data.error) {
                    console.error("Queue error:", data.error);
                    inQueue = false;
                    return;
                }

                if (data.status === "READY") {
                    dispatch("startsession", { sessionId: data.sessionId, sessionType: containerType });
                } else {
                    queuePosition = data.position;
                    setTimeout(poll, 2000);
                }
            } catch (e) {
                console.error("Queue poll failed:", e);
                setTimeout(poll, 5000);
            }
        };
        setTimeout(poll, 2000);
    }
</script>

<div class="fixed inset-0 bg-gray-900 bg-opacity-80 flex items-center justify-center z-50 transition-opacity duration-300">
    <div class="bg-gray-800 p-8 rounded-lg shadow-2xl transform scale-95 transition-transform duration-300 w-full max-w-md">
        {#if !inQueue}
            <div>
                <h2 class="text-2xl font-bold mb-4 text-white">Start New GLua Session</h2>
                <p class="text-gray-400 mb-6">Select your desired game branch and spin up a real GMod environment in seconds</p>
                <div class="mb-4">
                    <label for="container-type-select" class="block text-sm font-medium text-gray-300 mb-2 text-left">GMod Branch</label>
                    <select bind:value={containerType} class="block w-full bg-gray-700 border border-gray-600 text-white rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                        <option value="public">Public</option>
                        <option value="sixty-four">64-bit</option>
                        <option value="prerelease">Prerelease</option>
                        <option value="dev">Dev</option>
                    </select>
                </div>

                <!-- Advanced Options Toggle -->
                <button on:click={() => showAdvanced = !showAdvanced} class="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors duration-200 mb-4">
                    <svg class="w-3.5 h-3.5 transition-transform duration-200" class:rotate-90={showAdvanced} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                    Advanced Options
                </button>

                {#if showAdvanced}
                    <div class="space-y-4 mb-6 pl-1 border-l-2 border-gray-700 ml-1">
                        <!-- Map -->
                        <div class="pl-4">
                            <label class="block text-sm font-medium text-gray-300 mb-1.5 text-left">Map</label>
                            <select bind:value={map} class="block w-full bg-gray-700 border border-gray-600 text-white rounded-md p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                                <option value="gm_construct">gm_construct</option>
                                <option value="gm_flatgrass">gm_flatgrass</option>
                                <option value="gm_fork">gm_fork</option>
                            </select>
                        </div>

                        <!-- Gamemode -->
                        <div class="pl-4">
                            <label class="block text-sm font-medium text-gray-300 mb-1.5 text-left">Gamemode</label>
                            <input type="text" bind:value={gamemode} placeholder="sandbox" class="block w-full bg-gray-700 border border-gray-600 text-white rounded-md p-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                        </div>

                        <!-- Git Addon Repos -->
                        <div class="pl-4">
                            <label class="block text-sm font-medium text-gray-300 mb-1.5 text-left">Git Addon Repos</label>
                            <div class="space-y-2">
                                {#each gitRepos as repo, i}
                                    <div class="flex gap-2">
                                        <input type="url" value={repo} on:input={(e) => updateRepo(i, e.currentTarget.value)} placeholder="https://github.com/user/addon-repo" class="flex-1 bg-gray-700 border border-gray-600 text-white rounded-md p-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                                        <button on:click={() => removeRepo(i)} class="px-2.5 text-gray-400 hover:text-red-400 transition-colors duration-200" title="Remove">
                                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                        </button>
                                    </div>
                                {/each}
                                {#if gitRepos.length < 5}
                                    <button on:click={addRepo} class="flex items-center gap-1.5 text-sm text-indigo-400 hover:text-indigo-300 transition-colors duration-200">
                                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                                        Add Repository
                                    </button>
                                {/if}
                                {#if repoError}
                                    <p class="text-red-400 text-xs">{repoError}</p>
                                {/if}
                            </div>
                        </div>
                    </div>
                {:else}
                    <div class="mb-6"></div>
                {/if}

                {#if sessionError}
                    <p class="text-red-400 text-sm mb-4">{sessionError}</p>
                {/if}
                <button on:click={requestSession} class="bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 px-8 rounded-lg transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-indigo-400 disabled:bg-gray-500 disabled:cursor-wait">Start</button>
            </div>
        {:else}
            <div>
                <svg class="animate-spin h-8 w-8 text-indigo-400 mx-auto mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                <h2 class="text-xl font-bold mb-2 text-white">You are in the queue...</h2>
                <p class="text-gray-400">All available sessions are currently in use. Please wait.</p>
                <p class="text-lg font-mono text-indigo-300 mt-4">Position: <span>{queuePosition}</span></p>
            </div>
        {/if}
    </div>
</div>
