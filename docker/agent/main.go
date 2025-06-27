package main

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hpcloud/tail"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
)

// WebSocketMessage matches the structure defined in our TypeScript worker.
type WebSocketMessage struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload,omitempty"`
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
)

var shutdownOnce sync.Once

func main() {
	if workerURL == "" || sessionID == "" {
		log.Fatal("WORKER_URL and SESSION_ID environment variables are required")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pid, err := waitForAndReadPID(ctx, pidFilePath)
	if err != nil {
		log.Fatalf("Failed to get game server PID: %v", err)
	}
	log.Printf("Now monitoring game server with PID: %d", pid)

	conn, err := connectToWorker(ctx)
	if err != nil {
		log.Fatalf("Failed to establish WebSocket connection: %v", err)
	}
	defer conn.Close()
	log.Println("Connection established with worker.")

	go dumpInitialLogs(ctx, conn)
	go tailLogs(ctx, conn)
	go sendHealthStats(ctx, conn)
	go monitorGameProcess(ctx, pid, conn, cancel)

	listenForCommands(ctx, conn)
	shutdown(conn, cancel)
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
			// CORRECTED: Use os.ReadFile instead of ioutil.ReadFile
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
	u.RawQuery = q.Encode()

	log.Printf("Connecting to %s", u.String())
	c, _, err := websocket.DefaultDialer.DialContext(ctx, u.String(), nil)
	return c, err
}

// monitorGameProcess checks if the game server process is still running.
func monitorGameProcess(ctx context.Context, pid int, c *websocket.Conn, cancel context.CancelFunc) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	process, err := os.FindProcess(pid)
	if err != nil {
		log.Printf("Could not find process with PID %d: %v. Shutting down.", pid, err)
		shutdown(c, cancel)
		return
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// CORRECTED: The standard way to check if a process exists on Linux is to send it signal 0.
			err := process.Signal(syscall.Signal(0))
			if err != nil {
				// If the error is "os: process already finished", it means the process is dead.
				log.Printf("Game server process (PID: %d) is no longer running (err: %v). Shutting down.", pid, err)
				shutdown(c, cancel)
				return
			}
		}
	}
}

func shutdown(c *websocket.Conn, cancel context.CancelFunc) {
	shutdownOnce.Do(func() {
		log.Println("Initiating shutdown sequence...")
		cancel()

		dumpInitialLogs(context.Background(), c)
		c.WriteJSON(WebSocketMessage{Type: "AGENT_SHUTDOWN", Payload: "Agent is shutting down."})
		c.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(1000, "Normal Closure"))
		time.Sleep(1 * time.Second)

		log.Println("Shutdown complete. Exiting.")
		os.Exit(0)
	})
}

// --- WebSocket Communication Goroutines ---

func dumpInitialLogs(ctx context.Context, c *websocket.Conn) {
	initialContent, err := os.ReadFile(logFilePath)
	if err != nil {
		if !os.IsNotExist(err) { log.Printf("Error reading initial log file: %v", err) }
		return
	}
	if len(initialContent) > 0 {
		message := WebSocketMessage{Type: "HISTORY_DUMP", Payload: strings.Split(string(initialContent), "\n")}
		if err := c.WriteJSON(message); err != nil { log.Println("Failed to dump initial logs:", err) }
	}
}

func tailLogs(ctx context.Context, c *websocket.Conn) {
	t, err := tail.TailFile(logFilePath, tail.Config{Follow: true, ReOpen: true, MustExist: false})
	if err != nil { log.Printf("Failed to tail log file: %v", err); return }
	defer t.Stop()

	for {
		select {
		case <-ctx.Done(): return
		case line, ok := <-t.Lines:
			if !ok { return }
			if line == nil { continue }
			message := WebSocketMessage{Type: "LOG", Payload: line.Text}
			if err := c.WriteJSON(message); err != nil { log.Println("Error sending log message:", err); return }
		}
	}
}

func sendHealthStats(ctx context.Context, c *websocket.Conn) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done(): return
		case <-ticker.C:
			diskStat, err := disk.Usage("/")
			if err != nil { log.Printf("Failed to get disk usage: %v", err); continue }
			
			cpuPercentages, err := cpu.Percent(time.Second, false)
			if err != nil { log.Printf("Failed to get cpu usage: %v", err); continue }

			stats := HealthStats{
				CPUUsage:  cpuPercentages[0],
				DiskUsage: diskStat.UsedPercent,
			}
			message := WebSocketMessage{Type: "HEALTH", Payload: stats}
			if err := c.WriteJSON(message); err != nil { log.Println("Error sending health message:", err); return }
		}
	}
}

type readResult struct {
	msg WebSocketMessage
	err error
}

func listenForCommands(ctx context.Context, c *websocket.Conn) {
	readChan := make(chan readResult, 1)

	go func() {
		defer close(readChan)

		for {
			var msg WebSocketMessage
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
			if msg.Type == "COMMAND" {
				command, ok := msg.Payload.(string)
				if !ok {
					log.Println("Received invalid command payload.")
					continue
				}

				log.Printf("Executing command: %s", command)
				cmd := exec.Command("screen", "-S", "gmod", "-X", "stuff", command+"\n")
				if err := cmd.Run(); err != nil {
					log.Printf("Error executing command: %v", err)
				}
			}
		}
	}
}
