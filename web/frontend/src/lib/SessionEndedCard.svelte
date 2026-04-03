<script lang="ts">
    export let sessionId: string;

    let dismissed = false;
    let copied = false;

    function share() {
        const url = `${window.location.origin}/?session=${sessionId}`;
        navigator.clipboard.writeText(url).then(() => {
            copied = true;
            setTimeout(() => { copied = false; }, 2000);
        });
    }
</script>

{#if !dismissed}
    <div class="absolute inset-0 flex items-center justify-center z-30 pointer-events-none">
        <div class="bg-gray-800 border border-gray-700/50 rounded-xl shadow-2xl px-8 py-6 max-w-sm w-full mx-4 text-center pointer-events-auto">
            <button on:click={() => dismissed = true} class="absolute top-3 right-3 text-gray-500 hover:text-gray-300 transition-colors">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
                </svg>
            </button>
            <div class="text-2xl mb-3">👋</div>
            <p class="text-white font-semibold text-sm mb-1">Thanks for using glua.dev!</p>
            <p class="text-gray-400 text-xs mb-5">Free forever, with 💖 from <a href="https://github.com/CFC-Servers" target="_blank" rel="noopener noreferrer" class="text-indigo-400 hover:text-indigo-300 hover:underline">CFC Servers</a></p>
            <div class="flex gap-2 justify-center">
                <button on:click={() => window.location.href = "/"} class="px-4 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs font-medium transition-colors">
                    New session
                </button>
                <button on:click={share} class="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors min-w-[80px]">
                    {copied ? "Copied!" : "Share"}
                </button>
            </div>
        </div>
    </div>
{/if}
