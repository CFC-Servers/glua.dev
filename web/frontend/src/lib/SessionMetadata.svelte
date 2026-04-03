<script lang="ts">
    import { sessionMetadata } from "./stores";
</script>

{#if $sessionMetadata}
    <div class="text-xs space-y-1">
        <div class="flex justify-between"><span class="text-gray-400">Branch:</span><a href="https://steamdb.info/app/4000/depots/?branch={$sessionMetadata.branch}" target="_blank" rel="noopener noreferrer" class="font-mono text-indigo-400 hover:text-indigo-300 hover:underline truncate">{$sessionMetadata.branch}</a></div>
        <div class="flex justify-between"><span class="text-gray-400">Game Ver:</span><a href="https://steamdb.info/patchnotes/{$sessionMetadata.gameVersion}" target="_blank" rel="noopener noreferrer" class="font-mono text-indigo-400 hover:text-indigo-300 hover:underline truncate">{$sessionMetadata.gameVersion}</a></div>
        <div class="flex justify-between"><span class="text-gray-400">Container:</span><span class="font-mono text-gray-200 truncate">{$sessionMetadata.containerTag}</span></div>
    </div>
{/if}
