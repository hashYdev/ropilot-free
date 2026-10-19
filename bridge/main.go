// Command ropilot-infra is the local bridge between Ropilot Studio's Electron
// client and the Claude Code / Codex CLIs.
//
// Ropilot ships this bridge as an amd64 Go binary. On arm64 Linux it cannot be
// executed at all, and the client gates its whole startup on it — the app shows
// "Ropilot local server failed to become ready" and refuses to open without it.
// So this is a from-scratch implementation of the surface the client actually
// speaks, built for the host it has to run on.
//
// The client contract, read out of the shipped client:
//
//	GET  /health              -> 200, the client gates startup on this
//	GET  /ws                  -> websocket, JSON frames both ways
//	POST /chat-sync/commit    -> 200, the client's only other HTTP call
//
// Over the websocket the client sends {"type": ..., ...} and expects
// {"type": "agent_text" | "reasoning" | "done" | "error" | "status", ...}
// back. Chat turns arrive as type "user" and carry the prompt, the provider
// and the project directory.
//
// The environment is set by the client when it spawns this:
//
//	PORT               the port to listen on (8765)
//	ROPILOT_USERDATA   where projects, chats and provider logins live
//	ROPILOT_EDGE_URL   their hosted edge, for anything that wants to phone home
//	ANTHROPIC_API_KEY  set when the user has saved a key
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rs/cors"
)

// ── the client's message vocabulary ─────────────────────────────────────────

// Incoming is a frame from the client. Only the fields this bridge acts on are
// named; the client sends a lot more than that.
type Incoming struct {
	Type       string          `json:"type"`
	ChatID     string          `json:"chat_id"`
	SessionID  string          `json:"session_id"`
	Content    json.RawMessage `json:"content"`
	Provider   string          `json:"provider"`
	Model      string          `json:"model"`
	APIKey     string          `json:"api_key"`
	ProjectDir string          `json:"project_dir"`
	WorkingDir string          `json:"working_dir"`

	// The prompt, which the client sends either as a bare string or as
	// {content, ...} depending on where it came from.
	Prompt        string `json:"prompt"`
	CustomPrompt  string `json:"custom_prompt"`
	Reasoning     string `json:"reasoning_level"`
	ServiceTier   string `json:"service_tier"`
	ExecutionMode string `json:"execution_mode"`
}

// Outgoing is a frame to the client. The chat id goes back as session_id,
// because that is the field the client routes on.
type Outgoing struct {
	Type    string `json:"type"`
	ChatID  string `json:"session_id,omitempty"`
	Content any    `json:"content,omitempty"`
	Error   string `json:"error,omitempty"`
}

// content is the shape the client parses back out of msg.content. It tries
// JSON.parse on the string form and then reads .text, .message or .error.
type content struct {
	Text    string `json:"text,omitempty"`
	Message string `json:"message,omitempty"`
	Error   string `json:"error,omitempty"`
}

func (i Incoming) prompt() string {
	if i.Prompt != "" {
		return i.Prompt
	}
	if len(i.Content) == 0 {
		return ""
	}
	// A bare JSON string.
	var s string
	if err := json.Unmarshal(i.Content, &s); err == nil {
		return s
	}
	// Or an object with the text in it.
	var obj struct {
		Content string `json:"content"`
		Text    string `json:"text"`
		Prompt  string `json:"prompt"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(i.Content, &obj); err == nil {
		for _, v := range []string{obj.Content, obj.Text, obj.Prompt, obj.Message} {
			if v != "" {
				return v
			}
		}
	}
	return string(i.Content)
}

func (i Incoming) dir() string {
	if i.ProjectDir != "" {
		return i.ProjectDir
	}
	return i.WorkingDir
}

// ── the bridge ───────────────────────────────────────────────────────────────

type bridge struct {
	mu      sync.Mutex
	cancels map[string]func() // chat id -> cancel the running turn
	apiKey  string
	version string
}

func newBridge() *bridge {
	return &bridge{
		cancels: map[string]func(){},
		version: "1.0.0-free",
	}
}

func (b *bridge) setCancel(chatID string, fn func()) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.cancels[chatID] = fn
}

func (b *bridge) clearCancel(chatID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.cancels, chatID)
}

func (b *bridge) cancel(chatID string) bool {
	b.mu.Lock()
	fn, ok := b.cancels[chatID]
	b.mu.Unlock()
	if ok {
		fn()
	}
	return ok
}

func (b *bridge) key() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.apiKey
}

func (b *bridge) setKey(k string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.apiKey = k
}

// ── http surface ─────────────────────────────────────────────────────────────

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// The client connects from the app's own origin, and the port it
	// advertises is a file:// page, so the origin check has to be permissive.
	CheckOrigin: func(r *http.Request) bool { return true },
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8765"
	}
	userData := os.Getenv("ROPILOT_USERDATA")
	if userData == "" {
		userData = filepath.Join(homeDir(), ".config", "ropilot")
	}
	edge := os.Getenv("ROPILOT_EDGE_URL")

	b := newBridge()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		// The 1.3.2 client requires status == "healthy" and ready == true.
		// The 1.3.1 client only looks at the HTTP status, so one payload
		// satisfies both.
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":  "healthy",
			"ready":   true,
			"version": b.version,
			"pid":     os.Getpid(),
		})
	})
	mux.HandleFunc("/providers", func(w http.ResponseWriter, r *http.Request) {
		// Which provider CLIs are actually installed. The client uses this to
		// decide which models to offer — the Ropilot side has no way to ask
		// about an arbitrary binary, but it can ask the bridge.
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"claude":   haveBinary("claude"),
			"codex":    haveBinary("codex"),
			"opencode": haveBinary("opencode"),
		})
	})
	mux.HandleFunc("/ws", b.handleWS)
	mux.HandleFunc("/chat-sync/commit", func(w http.ResponseWriter, r *http.Request) {
		// The client posts its project/chats snapshot here to keep the
		// server's copy in step. Nothing reads it back, so accept and drop.
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusNoContent)
	})

	// The shipped binary uses rs/cors, so the client's fetches are CORS-checked.
	h := cors.New(cors.Options{
		AllowedOrigins: []string{"*"},
		AllowedMethods: []string{"GET", "POST", "OPTIONS", "PUT", "DELETE"},
		AllowedHeaders: []string{"*"},
	}).Handler(mux)

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("ropilot-infra (free) %s listening on :%s", b.version, port)
	log.Printf("userdata %s", userData)
	if edge != "" {
		log.Printf("edge %s", edge)
	}

	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		_ = srv.Close()
	}()

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("ropilot-infra: %v", err)
	}
}

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return "/root"
}

// ── websocket surface ───────────────────────────────────────────────────────

func (b *bridge) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	// A writer per connection, so a long turn cannot interleave with a
	// control frame.
	var wmu sync.Mutex
	send := func(o Outgoing) {
		wmu.Lock()
		defer wmu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
		if err := conn.WriteJSON(o); err != nil {
			log.Printf("ws write failed: %v", err)
		}
	}

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var msg Incoming
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("ws: bad frame: %v", err)
			continue
		}
		b.dispatch(msg, send)
	}
}

func (b *bridge) dispatch(msg Incoming, send func(Outgoing)) {
	// A chat turn arrives as a frame with no type at all: the client builds
	// {prompt, session_id, provider, model, ...} and sends it as-is. Only
	// the control frames carry a type. So the presence of a prompt is what
	// marks a turn.
	if msg.Type == "" && msg.Prompt != "" {
		msg.Type = "user"
	}
	if msg.ChatID == "" {
		msg.ChatID = msg.SessionID
	}

	switch msg.Type {
	case "set_api_key":
		if msg.APIKey != "" {
			b.setKey(msg.APIKey)
		}
		send(Outgoing{Type: "status", ChatID: msg.ChatID, Content: content{Text: "api key set"}})

	case "user", "steer":
		go b.runTurn(msg, send)

	case "stop":
		if b.cancel(msg.ChatID) {
			send(Outgoing{Type: "status", ChatID: msg.ChatID, Content: content{Text: "stopped"}})
		}

	case "create_chat", "update_chat", "delete_chat", "delete_session",
		"rename", "save_project", "delete_project", "full_sync",
		"checksum", "diff", "git-bash", "playtest", "compaction",
		"model", "settings", "configure-dir", "path_mapping",
		"discord_presence", "set_render_style", "set_add_ropilot_mcp_server",
		"plan_mode_response", "plan_review", "ask_question", "ask_user_answer":
		// These are persisted on the client side. Nothing to do for them
		// here, and the client does not wait on a reply.
		send(Outgoing{Type: "status", ChatID: msg.ChatID, Content: content{Text: "ok"}})

	case "emit":
		// The client relays its own events over the same socket.
		send(Outgoing{Type: "emit", ChatID: msg.ChatID, Content: msg.Content})

	default:
		log.Printf("ws: unhandled type %q", msg.Type)
	}
}

// ── a chat turn ──────────────────────────────────────────────────────────────

func (b *bridge) runTurn(msg Incoming, send func(Outgoing)) {
	prompt := msg.prompt()
	if strings.TrimSpace(prompt) == "" {
		send(Outgoing{Type: "error", ChatID: msg.ChatID,
			Error: "empty prompt"})
		return
	}

	provider := strings.ToLower(msg.Provider)
	if provider == "" {
		provider = "claude"
	}

	bin, args, err := cliFor(provider, msg)
	if err != nil {
		send(Outgoing{Type: "error", ChatID: msg.ChatID, Error: err.Error()})
		send(Outgoing{Type: "done", ChatID: msg.ChatID})
		return
	}

	dir := msg.dir()
	cmd := exec.Command(bin, args...)
	if dir != "" {
		if st, err := os.Stat(dir); err == nil && st.IsDir() {
			cmd.Dir = dir
		}
	}
	cmd.Env = os.Environ()
	if k := b.key(); k != "" {
		cmd.Env = append(cmd.Env, "ANTHROPIC_API_KEY="+k)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		send(Outgoing{Type: "error", ChatID: msg.ChatID, Error: err.Error()})
		return
	}
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		send(Outgoing{Type: "error", ChatID: msg.ChatID,
			Error: fmt.Sprintf("could not start %s: %v", bin, err)})
		send(Outgoing{Type: "done", ChatID: msg.ChatID})
		return
	}

	// Cancel wiring, so a "stop" from the client kills the CLI.
	done := make(chan struct{})
	b.setCancel(msg.ChatID, func() {
		select {
		case <-done:
		default:
			_ = cmd.Process.Signal(syscall.SIGTERM)
		}
	})
	defer func() {
		close(done)
		b.clearCancel(msg.ChatID)
	}()

	streamEvents(stdout, provider, func(kind, text string) {
		switch kind {
		case "reasoning":
			send(Outgoing{Type: "reasoning", ChatID: msg.ChatID,
				Content: content{Text: text}})
		case "text":
			send(Outgoing{Type: "agent_text", ChatID: msg.ChatID,
				Content: content{Text: text}})
		case "error":
			send(Outgoing{Type: "error", ChatID: msg.ChatID, Error: text})
		}
	})

	if err := cmd.Wait(); err != nil {
		send(Outgoing{Type: "error", ChatID: msg.ChatID, Error: err.Error()})
	}
	send(Outgoing{Type: "done", ChatID: msg.ChatID})
}

// cliFor resolves the provider to a command line.
func cliFor(provider string, msg Incoming) (string, []string, error) {
	switch provider {
	case "opencode":
		bin, err := lookPath("opencode")
		if err != nil {
			return "", nil, fmt.Errorf(
				"the OpenCode CLI is not installed — install it and sign in, then retry")
		}
		// --format json makes it emit NDJSON events instead of plain text,
		// which is what lets the client render reasoning separately from the
		// answer. --auto approves the tool permissions a non-interactive run
		// would otherwise block on, so the agent can actually write files.
		args := []string{"run", "--format", "json", "--auto"}
		if agent := opencodeAgent(); agent != "" {
			args = append(args, "--agent", agent)
		}
		if msg.Model != "" {
			args = append(args, "--model", msg.Model)
		}
		args = append(args, msg.prompt())
		return bin, args, nil

	case "codex":
		bin, err := lookPath("codex")
		if err != nil {
			return "", nil, fmt.Errorf(
				"the Codex CLI is not installed — install it and sign in, then retry")
		}
		args := []string{"exec", "--json"}
		if msg.Model != "" {
			args = append(args, "--model", msg.Model)
		}
		if dir := msg.dir(); dir != "" {
			args = append(args, "--cd", dir)
		}
		args = append(args, msg.prompt())
		return bin, args, nil

	default: // claude
		bin, err := lookPath("claude")
		if err != nil {
			return "", nil, fmt.Errorf(
				"the Claude CLI is not installed — install it and sign in, then retry")
		}
		args := []string{"-p", "--output-format", "stream-json", "--verbose"}
		if msg.Model != "" {
			args = append(args, "--model", msg.Model)
		}
		if msg.CustomPrompt != "" {
			args = append(args, "--append-system-prompt", msg.CustomPrompt)
		}
		args = append(args, msg.prompt())
		return bin, args, nil
	}
}

func lookPath(name string) (string, error) {
	p, err := exec.LookPath(name)
	if err != nil {
		return "", err
	}
	return p, nil
}

// haveBinary reports whether a CLI is on PATH.
func haveBinary(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// ── parsing the CLIs' output ────────────────────────────────────────────────

// streamEvents reads newline-delimited JSON from the CLI and reports the text
// it finds. Both CLIs emit NDJSON on stdout, but with different shapes, so
// both are handled and anything unrecognised is passed through as plain text.
func streamEvents(r io.Reader, provider string, emit func(kind, text string)) {
	dec := json.NewDecoder(r)
	for {
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			if err == io.EOF {
				return
			}
			return
		}
		for _, ev := range parseEvent(raw, provider) {
			emit(ev.kind, ev.text)
		}
	}
}

type event struct {
	kind string // "text", "reasoning" or "error"
	text string
}

func parseEvent(raw json.RawMessage, provider string) []event {
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		// Not JSON — treat it as a line of output.
		s := strings.TrimSpace(string(raw))
		if s == "" {
			return nil
		}
		return []event{{"text", s}}
	}

	typ, _ := obj["type"].(string)

	if provider == "opencode" {
		// opencode run --format json emits one object per event, with the
		// payload in "part" for content events and in "error" for failures.
		switch typ {
		case "text":
			if t := partText(obj); t != "" {
				return []event{{"text", t}}
			}
		case "reasoning", "thinking":
			if t := partText(obj); t != "" {
				return []event{{"reasoning", t}}
			}
		case "error":
			return []event{{"error", errorText(obj)}}
		}
		return nil
	}

	if provider == "codex" {
		switch typ {
		case "item.completed":
			item, _ := obj["item"].(map[string]any)
			if item != nil {
				if t, ok := item["text"].(string); ok && t != "" {
					return []event{{"text", t}}
				}
			}
		case "item.started", "thread.started", "turn.started":
			return nil
		case "error":
			return []event{{"error", stringify(obj)}}
		}
		return nil
	}

	// Claude Code stream-json.
	switch typ {
	case "assistant":
		msg, _ := obj["message"].(map[string]any)
		if msg != nil {
			parts, _ := msg["content"].([]any)
			for _, p := range parts {
				pm, _ := p.(map[string]any)
				if pm == nil {
					continue
				}
				switch pm["type"] {
				case "text":
					if t, ok := pm["text"].(string); ok && t != "" {
						return []event{{"text", t}}
					}
				case "thinking":
					if t, ok := pm["thinking"].(string); ok && t != "" {
						return []event{{"reasoning", t}}
					}
				}
			}
		}
	case "result":
		if t, ok := obj["result"].(string); ok && t != "" {
			return []event{{"text", t}}
		}
		if obj["is_error"] == true {
			return []event{{"error", stringify(obj)}}
		}
	case "system":
		return nil
	}
	return nil
}

func stringify(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

// opencodeAgent is the agent opencode is asked to use. Overridable so the
// same bridge can drive a different agent without a rebuild.
func opencodeAgent() string {
	if a := strings.TrimSpace(os.Getenv("ROPILOT_OPENCODE_AGENT")); a != "" {
		return a
	}
	return "spacebunny"
}

// partText pulls the text out of an opencode event's "part" object.
func partText(obj map[string]any) string {
	part, _ := obj["part"].(map[string]any)
	if part == nil {
		return ""
	}
	switch t := part["text"].(type) {
	case string:
		return t
	case nil:
		// some events carry the text under "reasoning" instead
		if s, ok := part["reasoning"].(string); ok {
			return s
		}
	}
	return ""
}

// errorText pulls the message out of an opencode error event.
func errorText(obj map[string]any) string {
	e, _ := obj["error"].(map[string]any)
	if e == nil {
		return stringify(obj)
	}
	if s, ok := e["message"].(string); ok && s != "" {
		return s
	}
	return stringify(e)
}
