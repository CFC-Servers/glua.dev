<script lang="ts">
    import { sessionMetadata } from "./stores";

    let showConfig = false;

    $: opts = $sessionMetadata?.options;
    $: hasNonDefaults = opts && (
        opts.map !== "gm_construct" ||
        opts.gamemode !== "sandbox" ||
        opts.gitRepos.length > 0
    );
</script>

{#if $sessionMetadata}
    <div class="text-xs space-y-1">
        <div class="flex justify-between"><span class="text-gray-400">Started:</span><span class="font-mono text-gray-200">{new Date($sessionMetadata.startedAt).toLocaleString()}</span></div>
        <div class="flex justify-between"><span class="text-gray-400">Branch:</span><a href="https://steamdb.info/app/4000/depots/?branch={$sessionMetadata.branch}" target="_blank" rel="noopener noreferrer" class="font-mono text-indigo-400 hover:text-indigo-300 hover:underline truncate">{$sessionMetadata.branch}</a></div>
        <div class="flex justify-between"><span class="text-gray-400">Game Ver:</span><a href="https://steamdb.info/patchnotes/{$sessionMetadata.gameVersion}" target="_blank" rel="noopener noreferrer" class="font-mono text-indigo-400 hover:text-indigo-300 hover:underline truncate">{$sessionMetadata.gameVersion}</a></div>
        <div class="flex justify-between"><span class="text-gray-400">Container:</span><span class="font-mono text-gray-200 truncate">{$sessionMetadata.containerTag}</span></div>

        {#if hasNonDefaults}
            <div class="border-t border-gray-700 mt-2 pt-2">
                <button on:click={() => showConfig = !showConfig} class="flex items-center gap-1 text-gray-400 hover:text-gray-200 transition-colors duration-200 w-full text-left">
                    <svg class="w-3 h-3 transition-transform duration-200" class:rotate-90={showConfig} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                    <span class="text-xs">Session Config</span>
                </button>
                {#if showConfig && opts}
                    <div class="mt-1.5 space-y-1 pl-4">
                        {#if opts.map !== "gm_construct"}
                            <div class="flex justify-between"><span class="text-gray-400">Map:</span><span class="font-mono text-gray-200">{opts.map}</span></div>
                        {/if}
                        {#if opts.gamemode !== "sandbox"}
                            <div class="flex justify-between"><span class="text-gray-400">Gamemode:</span><span class="font-mono text-gray-200">{opts.gamemode}</span></div>
                        {/if}
                        {#if opts.gitRepos.length > 0}
                            <div>
                                <span class="text-gray-400">Addons:</span>
                                <div class="mt-0.5 space-y-0.5">
                                    {#each opts.gitRepos as repo}
                                        <a href={repo} target="_blank" rel="noopener noreferrer" class="block font-mono text-indigo-400 hover:text-indigo-300 hover:underline truncate">{repo.replace(/^https?:\/\/(www\.)?github\.com\//, "")}</a>
                                    {/each}
                                </div>
                            </div>
                        {/if}
                    </div>
                {/if}
            </div>
        {/if}
    </div>
{/if}
