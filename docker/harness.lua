-- glua.dev execution harness

--- @class GLuaDev_Harness
local Harness = {
    --- The diretory in `lua/` where scripts are saved and executed
    scriptDir = "gluadev",

    --- Script names that have already been seen and executed
    --- (This is poopy but will be fine for now)
    seenScripts = {},

    debug = true,
}

--- @class GLuaDev_Logger
local logger = {} do
    local Color = Color
    local MsgC = MsgC

    --- TODO Rename these to their purposes
    --- @class GLuaDev_Colors
    logger.colors = {
        lightblue = Color( 98, 144, 195 ),
        mintgreen = Color( 194, 231, 218 ),
        plain = Color( 241, 255, 231 ),
        lime = Color( 186, 255, 41 ),
        orange = Color( 245, 128, 37 ),
        red = Color( 254, 111, 94 ),
    }
    local colors = logger.colors

    --- @private
    --- Generic logging function
    local function _log( ... )
        MsgC( colors.mintgreen, "[GLuaDev] ", ... )
        MsgC( "\n" )
    end

    --- Log an info message
    function logger:Info( ... )
        _log( colors.lightblue, "INFO: ", colors.plain, ... )
    end

    --- Log a warning message
    function logger:Warn( ... )
        _log( colors.orange, "WARN: ", colors.plain, ... )
    end

    --- Log an error message
    function logger:Error( ... )
        _log( colors.red, "ERROR: ", colors.plain, ... )
    end

    --- Log a debug message (only if debugging is enabled)
    function logger:Debug( ... )
        if Harness.debug then
            _log( colors.lime, "DEBUG: ", colors.plain, ... )
        end
    end

    Harness.Logger = logger
end

do
    local ipairs = ipairs
    local include = include
    local file_Find = file.Find
    local timer_Simple = timer.Simple
    local ProtectedCall = ProtectedCall

    local scriptDir = Harness.scriptDir
    local seenScripts = Harness.seenScripts

    local function processFile( filename )
        if seenScripts[filename] then return end

        seenScripts[filename] = true
        logger:Info( "Executing: ", logger.colors.lime, filename )

        -- Load and execute the script
        local scriptPath = scriptDir .. "/" .. filename
        ProtectedCall( include, scriptPath )
    end

    function Harness.CreateScriptWatcher()
        local findString = scriptDir .. "/*.lua"

        local function tick()
            local foundFiles = file_Find( findString, "LUA" )

            for _, filename in ipairs( foundFiles ) do
                processFile( filename )
            end

            timer_Simple( 0.25, tick )
        end

        timer_Simple( 0.25, tick )
    end
end

function Harness:Init()
    self.CreateScriptWatcher()
end

Harness:Init()
