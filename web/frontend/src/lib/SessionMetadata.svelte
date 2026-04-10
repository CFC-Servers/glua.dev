<script lang="ts">
    import { sessionMetadata, sessionState } from "./stores";
    import MetadataRow from "./MetadataRow.svelte";

    declare const __COMMIT_SHA__: string;
    const commitSha = __COMMIT_SHA__;

    $: showWebVersion = $sessionState !== "closed" && $sessionState !== "readonly";
</script>

{#if $sessionMetadata}
    <div class="text-xs space-y-1">
        <MetadataRow label="Started" value={new Date($sessionMetadata.startedAt).toLocaleString()} />
        <MetadataRow label="Branch" value={$sessionMetadata.branch} href="https://steamdb.info/app/4000/depots/?branch={$sessionMetadata.branch}" />
        <MetadataRow label="Game Ver" value={$sessionMetadata.gameVersion} href="https://steamdb.info/patchnotes/{$sessionMetadata.gameVersion}" />
        <MetadataRow label="Container" value={$sessionMetadata.containerTag} />
        {#if showWebVersion}
            <MetadataRow label="Web Ver" value={commitSha} href="https://github.com/CFC-Servers/glua.dev/tree/{commitSha}" />
        {/if}
    </div>
{/if}
