package main

import (
	"context"
	"fmt"
	"regexp"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"encoding/json"

	"github.com/gorilla/websocket"
	"github.com/hpcloud/tail"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
)

type WebSocketMessageIn struct {
	Type    string      `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type WebSocketMessageOut struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload,omitempty"`
}

type ScriptPayload struct {
    Name   string `json:"name"`
    Content string `json:"content"`
}

// HealthStats defines the structure for our health updates.
type HealthStats struct {
	CPUUsage  float64 `json:"cpuusage"`
	DiskUsage float64 `json:"diskusage"`
}

var (
	workerURL   = os.Getenv("WORKER_URL")
	sessionID   = os.Getenv("SESSION_ID")
	logFilePath = "/home/steam/gmodserver/garrysmod/console.log"
	pidFilePath = "/home/steam/gmodserver/garrysmod/gmod.pid"
	metadataDir = "/home/steam/metadata"
	scriptDir   = "/home/steam/gmodserver/garrysmod/lua/gluadev"
	scriptCount = 0

	gameBranch   string
	gameVersion  string
	containerTag string
)

var shutdownOnce sync.Once

func main() {
	if workerURL == "" || sessionID == "" {
		log.Fatal("WORKER_URL and SESSION_ID environment variables are required")
	}

	readMetadata()

	ctx, cancel := context.WithCancel(context.Background())

	pid, err := waitForAndReadPID(ctx, pidFilePath)
	if err != nil {
		cancel()
		log.Fatalf("Failed to get game server PID: %v", err)
	}
	log.Printf("Now monitoring game server with PID: %d", pid)

	conn, err := connectToWorker(ctx)
	if err != nil {
		cancel()
		log.Fatalf("Failed to establish WebSocket connection: %v", err)
	}
	log.Println("Connection established with worker.")

	writeChan := make(chan WebSocketMessageOut, 32)
	go webSocketWriter(conn, writeChan)

	sendMetadata(writeChan)
	dumpInitialLogs(writeChan)

	go tailLogs(ctx, writeChan)
	go sendHealthStats(ctx, writeChan)
	go monitorGameProcess(ctx, pid, writeChan, cancel)

	listenForCommands(ctx, conn)
	shutdown(writeChan, cancel)
}

func getGameVersionString() string {
    versionName := os.Getenv("GMOD_BRANCH")
    if versionName == "" {
        versionName = "live"
    }

    versionNameMap := map[string]string{
        "live":    "public",
        "x86-64":    "sixty-four",
        "prerelease": "prerelease",
        "dev":     "dev",
    }

    if version, ok := versionNameMap[versionName]; ok {
        return version
    } else {
        log.Printf("Unknown GMOD branch: %s, defaulting to 'public'", versionName)
        return "public"
    }
}

var nonAlphanum = regexp.MustCompile("[^a-zA-Z0-9]+")
func cleanFileName(fileName string) string {
    sanitized := nonAlphanum.ReplaceAllString(fileName, "")

	// Check if the resulting string is empty.
	if sanitized == "" {
		return "script"
	}

	return sanitized
}

// webSocketWriter is the only goroutine permitted to write to the WebSocket connection.
func webSocketWriter(c *websocket.Conn, writeChan <-chan WebSocketMessageOut) {
	defer c.Close()
	for message := range writeChan {
		if err := c.WriteJSON(message); err != nil {
			log.Printf("Error writing json to websocket: %v", err)
			return
		}
	}
	log.Println("Write channel closed. Sending close message.")
	c.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(1000, "Normal Closure"))
}

func waitForAndReadPID(ctx context.Context, path string) (int, error) {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()

	timeoutCtx, timeoutCancel := context.WithTimeout(ctx, 30*time.Second)
	defer timeoutCancel()

	for {
		select {
		case <-timeoutCtx.Done():
			return 0, fmt.Errorf("timed out waiting for PID file at %s", path)
		case <-ticker.C:
			pidBytes, err := os.ReadFile(path)
			if err == nil {
				pid, err := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
				if err == nil {
					return pid, nil
				}
			}
		}
	}
}

func connectToWorker(ctx context.Context) (*websocket.Conn, error) {
    versionString := getGameVersionString()

	u, err := url.Parse(workerURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse WORKER_URL: %w", err)
	}
	u.Scheme = "wss"
	if strings.HasPrefix(workerURL, "http://") {
		u.Scheme = "ws"
	}
	u.Path = "/ws/agent"

	q := u.Query()
	q.Set("session", sessionID)
	q.Set("type", versionString)
	u.RawQuery = q.Encode()

	log.Printf("Connecting to %s", u.String())
	c, _, err := websocket.DefaultDialer.DialContext(ctx, u.String(), nil)
	return c, err
}

// monitorGameProcess checks if the game server process is still running.
func monitorGameProcess(ctx context.Context, pid int, writeChan chan<- WebSocketMessageOut, cancel context.CancelFunc) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	process, err := os.FindProcess(pid)
	if err != nil {
		log.Printf("Could not find process with PID %d: %v. Shutting down.", pid, err)
		shutdown(writeChan, cancel)
		return
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			err := process.Signal(syscall.Signal(0))
			if err != nil {
				log.Printf("Game server process (PID: %d) is no longer running (err: %v). Shutting down.", pid, err)
				shutdown(writeChan, cancel)
				return
			}
		}
	}
}

func sendMetadata(writeChan chan<- WebSocketMessageOut) {
	message := WebSocketMessageOut{
		Type: "METADATA",
		Payload: map[string]string{
			"branch":       gameBranch,
			"gameVersion":  gameVersion,
			"containerTag": containerTag,
		},
	}
	writeChan <- message
}

func shutdown(writeChan chan<- WebSocketMessageOut, cancel context.CancelFunc) {
	shutdownOnce.Do(func() {
		log.Println("Initiating shutdown sequence...")
		cancel()

		writeChan <- WebSocketMessageOut{Type: "AGENT_SHUTDOWN", Payload: "Agent is shutting down."}

		close(writeChan)

		time.Sleep(1 * time.Second)

		log.Println("Shutdown complete. Exiting.")
		os.Exit(0)
	})
}

// --- WebSocket Communication Goroutines ---

func dumpInitialLogs(writeChan chan<- WebSocketMessageOut) {
	initialContent, err := os.ReadFile(logFilePath)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("Error reading initial log file: %v", err)
		}
		return
	}
	if len(initialContent) > 0 {
		message := WebSocketMessageOut{Type: "HISTORY_DUMP", Payload: strings.Split(string(initialContent), "\n")}
		writeChan <- message
	}
}

func tailLogs(ctx context.Context, writeChan chan<- WebSocketMessageOut) {
	time.Sleep(250 * time.Millisecond)
	t, err := tail.TailFile(logFilePath, tail.Config{Follow: true, ReOpen: true, MustExist: false})
	if err != nil {
		log.Printf("Failed to tail log file: %v", err)
		return
	}
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case line, ok := <-t.Lines:
			if !ok {
				return
			}
			if line == nil {
				continue
			}
			message := WebSocketMessageOut{Type: "LOG", Payload: line.Text}
			select {
			case writeChan <- message:
			case <-ctx.Done():
				return
			}
		}
	}
}

func sendHealthStats(ctx context.Context, writeChan chan<- WebSocketMessageOut) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	send := func() {
		diskStat, err := disk.Usage("/")
		if err != nil {
			log.Printf("Failed to get disk usage: %v", err)
			return
		}

		cpuPercentages, err := cpu.Percent(0, false)
		if err != nil {
			log.Printf("Failed to get cpu usage: %v", err)
			return
		}

		stats := HealthStats{
			CPUUsage:  cpuPercentages[0],
			DiskUsage: diskStat.UsedPercent,
		}
		message := WebSocketMessageOut{Type: "HEALTH", Payload: stats}
		select {
		case writeChan <- message:
		case <-ctx.Done():
		}
	}

	send()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			send()
		}
	}
}

type readResult struct {
	msg WebSocketMessageIn
	err error
}

func listenForCommands(ctx context.Context, c *websocket.Conn) {
	readChan := make(chan readResult, 1)

	go func() {
		defer close(readChan)

		for {
			var msg WebSocketMessageIn
			err := c.ReadJSON(&msg)

			select {
			case readChan <- readResult{msg: msg, err: err}:
			case <-ctx.Done():
				return
			}

			if err != nil {
				return
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			log.Println("Context cancelled, stopping listener.")
			return

		case result, ok := <-readChan:
			if !ok {
				log.Println("Read channel closed, connection is dead.")
				return
			}

			if result.err != nil {
				if websocket.IsUnexpectedCloseError(result.err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
					log.Printf("Unrecoverable websocket error: %v", result.err)
				}
				return
			}

			msg := result.msg
			switch msg.Type {
                case "COMMAND":
                    var command string
                    if err := json.Unmarshal(msg.Payload, &command); err != nil {
                        log.Printf("Error unmarshalling command payload: %v", err)
                        continue
                    }

                    log.Printf("Executing command: %s", command)
                    cmd := exec.Command("screen", "-S", "gmod", "-X", "stuff", command+"\n")
                    if err := cmd.Run(); err != nil {
                        log.Printf("Error executing command: %v", err)
                    }
                case "SCRIPT":
                    var script ScriptPayload
                    if err := json.Unmarshal(msg.Payload, &script); err != nil {
                        log.Printf("Error unmarshalling script payload: %v", err)
                        continue
                    }

                    scriptCount++
                    cleanName := cleanFileName(script.Name)
                    nameWithCount := fmt.Sprintf("%s_%d.lua", cleanName, scriptCount)

                    scriptPath := filepath.Join(scriptDir, nameWithCount)
                    contents := []byte(script.Content)

                    log.Printf("Saving Script to : %s", scriptPath)

                    if err := os.WriteFile(scriptPath, contents, 0644); err != nil {
                        log.Printf("Error writing script file: %v", err)
                        continue
                    }
            }
		}
	}
}

func readMetadata() {
	var err error
	gameBranch, err = readMetadataFile("game_branch.txt")
	if err != nil {
		log.Printf("Could not read game_branch.txt: %v", err)
	}
	gameVersion, err = readMetadataFile("game_version.txt")
	if err != nil {
		log.Printf("Could not read game_version.txt: %v", err)
	}
	containerTag, err = readMetadataFile("container_tag.txt")
	if err != nil {
		log.Printf("Could not read container_tag.txt: %v", err)
	}
}

func readMetadataFile(filename string) (string, error) {
	content, err := os.ReadFile(filepath.Join(metadataDir, filename))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(content)), nil
}
