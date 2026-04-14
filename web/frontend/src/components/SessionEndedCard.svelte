<script lang="ts">
    let copied = false;

    function share() {
        navigator.clipboard.writeText(window.location.href).then(() => {
            copied = true;
            setTimeout(() => { copied = false; }, 2000);
        });
    }
</script>

<div class="p-4">
    <div class="bg-gray-800 border border-gray-700/50 rounded-lg px-5 py-4 max-w-sm text-center">
        <p class="text-white font-semibold text-sm mb-1">Thanks for using glua.dev! 👋</p>
        <p class="text-gray-400 text-xs mb-3">Free forever, with 💖 from <a href="https://github.com/CFC-Servers" target="_blank" rel="noopener noreferrer" class="text-indigo-400 hover:text-indigo-300 hover:underline">CFC Servers</a></p>
        <div class="flex gap-2 justify-center">
            <button on:click={() => window.location.href = "/"} class="px-4 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs font-medium transition-colors">
                New session
            </button>
            <button on:click={share} class="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors min-w-[110px]">
                {copied ? "Copied!" : "Share Logs"}
            </button>
        </div>
    </div>
</div>
