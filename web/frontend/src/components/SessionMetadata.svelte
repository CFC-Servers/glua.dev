<script lang="ts">
    import { sessionMetadata, sessionState } from "../lib/stores";
    import MetadataRow from "./MetadataRow.svelte";

    declare const __COMMIT_SHA__: string;
    const commitSha = __COMMIT_SHA__;
    const commitHref = commitSha === "dev" ? undefined : `https://github.com/CFC-Servers/glua.dev/tree/${commitSha}`;

    $: showWebVersion = $sessionState !== "closed" && $sessionState !== "readonly";

    // `||` not `??`: the agent sends "" when it can't read the version file
    $: gameVersion = $sessionMetadata?.gameVersion || "unknown";
    $: gameVersionHref = gameVersion === "unknown" ? null : `https://steamdb.info/patchnotes/${gameVersion}`;
</script>

{#if $sessionMetadata}
    <div class="text-xs space-y-1">
        <MetadataRow label="Started" value={new Date($sessionMetadata.startedAt).toLocaleString()} />
        <MetadataRow label="Branch" value={$sessionMetadata.branch} href="https://steamdb.info/app/4000/depots/?branch={$sessionMetadata.branch}" />
        <MetadataRow label="Game Ver" value={gameVersion} href={gameVersionHref} />
        {#if showWebVersion}
            <MetadataRow label="Web Ver" value={commitSha} href={commitHref} />
        {/if}
        <MetadataRow label="Container" value={$sessionMetadata.containerTag} />
    </div>
{/if}
