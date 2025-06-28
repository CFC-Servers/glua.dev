<script lang="ts">
    import { onMount } from "svelte";
    import CodeMirror from 'svelte-codemirror-editor';
    import { EditorState } from "@codemirror/state";
    import { EditorView, keymap } from "@codemirror/view";
    import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
    import { StreamLanguage } from "@codemirror/language";
    import { lua } from "./lua-mode.js";
    import { oneDark } from "@codemirror/theme-one-dark";
    import { isEditorOpen } from './stores';

    export let socket: WebSocket | null;

    let editorView: EditorView | null = null;
    let editorPanel: HTMLDivElement;
    let runScriptButton: HTMLButtonElement;

    const customTheme = EditorView.theme({
        "&": {
            color: "#d1d5db",
            backgroundColor: "#1F2937"
        },
        ".cm-content": { caretColor: "#60a5fa" },
        "&.cm-focused .cm-cursor": { borderLeftColor: "#60a5fa" },
        "&.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "#3b82f680" },
        ".cm-gutters": {
            backgroundColor: "#1F2937",
            color: "#6b7280",
            border: "none"
        },
        ".cm-keyword": {color: "#c084fc"},
        ".cm-string": {color: "#a5f3fc"},
        ".cm-comment": {color: "#6b7280", fontStyle: "italic"},
        ".cm-number": {color: "#fca5a5"},
        ".cm-variableName": {color: "#d1d5db"},
        ".cm-operator": {color: "#93c5fd"},
        ".cm-function": {color: "#818cf8", fontWeight: "bold"}
    }, {dark: true});

    let value = localStorage.getItem("glua-editor-content") || `--[[
  Welcome to the GLua Editor!
  This is a sample script to demonstrate the editor's capabilities.
]]

-- Configuration
local PLUGIN = {}
PLUGIN.Name = "Advanced Entity Spawner"
PLUGIN.Author = "Your Name Here"
PLUGIN.Description = "A tool for spawning and manipulating entities."
PLUGIN.Version = "1.0.0"

-- Constants
local MAX_SPAWN_DISTANCE = 2048
local DEFAULT_MODEL = "models/props_c17/oildrum001.mdl"

-- Utility function to check player privileges
local function HasPermission(ply, permission)
  -- In a real scenario, this would check against a proper admin mod
  return ply:IsAdmin()
end

-- Spawns an entity in front of the player
local function SpawnEntity(ply, model)
  if not IsValid(ply) then return end
  if not util.IsValidModel(model) then
    print("Error: Invalid model '" .. tostring(model) .. "'")
    return
  end

  local trace = ply:GetEyeTrace()
  if not trace.Hit then
    print("Could not find a surface to spawn on.")
    return
  end

  if trace.HitPos:Distance(ply:GetShootPos()) > MAX_SPAWN_DISTANCE then
    print("Target is too far away.")
    return
  end

  local ent = ents.Create("prop_physics")
  if not IsValid(ent) then
    print("Failed to create entity.")
    return
  end

  ent:SetModel(model)
  ent:SetPos(trace.HitPos + trace.HitNormal * 5)
  ent:Spawn()
  ent:Activate()

  print("Spawned " .. model .. " successfully!")

  -- Make it undraggable for non-admins for fun
  if not HasPermission(ply, "can_drag_all") then
    ent:GetPhysicsObject():EnableMotion(false)
    timer.Simple(10, function()
      if IsValid(ent) then
        ent:GetPhysicsObject():EnableMotion(true)
        print(model .. " can now be moved.")
      end
    end)
  end
end

-- Console command to trigger the spawn
concommand.Add("adv_spawn", function(ply, cmd, args)
  if not IsValid(ply) then
    print("This command can only be run by a player.")
    return
  end

  if not HasPermission(ply, "can_use_adv_spawn") then
    print("You do not have permission to use this command.")
    return
  end

  local modelToSpawn = args[1] or DEFAULT_MODEL
  SpawnEntity(ply, modelToSpawn)
end)

-- A simple loop to demonstrate some logic
for i = 1, 5 do
  print("Initialization loop, iteration: " .. i)
  -- This could be used to pre-cache resources or something similar
end

-- Final setup message
print(PLUGIN.Name .. " v" .. PLUGIN.Version .. " by " .. PLUGIN.Author .. " has been loaded.")
print("Type 'adv_spawn [model_path]' in console to use.")
`;

    isEditorOpen.subscribe(open => {
        if (open) {
            setTimeout(() => editorView?.focus(), 300);
        }
    });

    function runScript() {
        if (!editorView || !socket || socket.readyState !== WebSocket.OPEN) return;
        const scriptContent = editorView.state.doc.toString().trim();
        if (scriptContent && !runScriptButton.disabled) {
                socket.send(JSON.stringify({ type: "RUN_SCRIPT", payload: scriptContent }));
                runScriptButton.disabled = true;
                setTimeout(() => {
                    runScriptButton.disabled = false;
                }, 1000);
        }
    }

    function startResize(e: MouseEvent) {
        e.preventDefault();
        editorPanel.classList.add('resizing');
        window.addEventListener('mousemove', doResize);
        window.addEventListener('mouseup', stopResize);
    }

    function doResize(e: MouseEvent) {
        const newWidth = window.innerWidth - e.clientX;
        if (newWidth > 200 && newWidth < window.innerWidth - 200) {
            editorPanel.style.width = `${newWidth}px`;
        }
    }

    function stopResize() {
        editorPanel.classList.remove('resizing');
        window.removeEventListener('mousemove', doResize);
        window.removeEventListener('mouseup', stopResize);
    }

    onMount(() => {
        const handleKeydown = (e: KeyboardEvent) => {
            if (e.key === '.' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                isEditorOpen.update(open => !open);
            }
        };
        window.addEventListener('keydown', handleKeydown);

        return () => {
            window.removeEventListener('keydown', handleKeydown);
        };
    });
</script>

<div class="relative h-full" class:open={$isEditorOpen}>
    <button id="editor-toggle-button" on:click={() => isEditorOpen.update(open => !open)}>
        {#if $isEditorOpen}
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-white" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M10.293 15.707a1 1 0 010-1.414L14.586 10l-4.293-4.293a1 1 0 111.414-1.414l5 5a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0z" clip-rule="evenodd" />
                <path fill-rule="evenodd" d="M4.293 15.707a1 1 0 010-1.414L8.586 10 4.293 5.707a1 1 0 011.414-1.414l5 5a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0z" clip-rule="evenodd" />
            </svg>
        {:else}
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-white" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M9.707 4.293a1 1 0 010 1.414L5.414 10l4.293 4.293a1 1 0 01-1.414 1.414l-5-5a1 1 0 010-1.414l5-5a1 1 0 011.414 0z" clip-rule="evenodd" />
                <path fill-rule="evenodd" d="M15.707 4.293a1 1 0 010 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414l-5-5a1 1 0 010-1.414l5-5a1 1 0 011.414 0z" clip-rule="evenodd" />
            </svg>
        {/if}
    </button>
    <div bind:this={editorPanel} id="editor-panel" class:open={$isEditorOpen}>
        <div on:mousedown={startResize} id="editor-resizer"></div>
        <div id="editor-panel-content">
            <div class="flex-grow relative">
                <CodeMirror
                    bind:value
                    bind:view={editorView}
                    lang={StreamLanguage.define(lua)}
                    theme={oneDark}
                    extensions={[
                        history(),
                        keymap.of([...defaultKeymap, ...historyKeymap]),
                        customTheme
                    ]}
                    on:change={(e) => localStorage.setItem("glua-editor-content", e.detail.value)}
                />
            </div>
            <div id="editor-footer">
                <button bind:this={runScriptButton} on:click={runScript} id="run-script-button" class="bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-md transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-indigo-400">
                    Run Script
                </button>
            </div>
        </div>
    </div>
</div>