package server

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"

	"claude-ui/internal/canvastools"
	"claude-ui/internal/images"
	"claude-ui/internal/live"
)

func constantTimeEq(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func errText(err error, fallback string) string {
	if s := err.Error(); s != "" {
		return s
	}
	return fallback
}

func rpcError(w http.ResponseWriter, id any, code int, msg string) {
	sendJSON(w, map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": msg}}, 200)
}

// handleMCP is the canvas tools as a minimal MCP server (streamable HTTP, JSON responses). Only the card's own
// Claude process knows the token; a browser can't use it (it would send an Origin, which is refused).
func handleMCP(w http.ResponseWriter, r *http.Request, cid, token string) {
	live.Mu.Lock()
	lv := live.Registry[cid]
	live.Mu.Unlock()
	if r.Header.Get("Origin") != "" || lv == nil || !constantTimeEq(token, lv.Token) {
		http.Error(w, "", 403)
		return
	}
	body, _ := io.ReadAll(r.Body)
	if len(body) == 0 {
		body = []byte("null")
	}
	var raw any
	if json.Unmarshal(body, &raw) != nil {
		rpcError(w, nil, -32700, "parse error")
		return
	}
	req, ok := raw.(map[string]any)
	if !ok {
		rpcError(w, nil, -32600, "invalid request")
		return
	}
	id, hasID := req["id"] // a notification (e.g. notifications/initialized): nothing to answer
	if !hasID {
		w.WriteHeader(202)
		return
	}
	method, _ := req["method"].(string)
	params, _ := req["params"].(map[string]any)
	if params == nil {
		params = map[string]any{}
	}
	var result any
	switch method {
	case "initialize":
		pv, _ := params["protocolVersion"].(string)
		if pv == "" {
			pv = "2025-06-18"
		}
		result = map[string]any{
			"protocolVersion": pv,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "claude-ui-canvas", "version": "1"},
		}
	case "ping":
		result = map[string]any{}
	case "tools/list":
		result = map[string]any{"tools": canvastools.Tools}
	case "tools/call":
		name, _ := params["name"].(string)
		args, _ := params["arguments"].(map[string]any)
		if args == nil {
			args = map[string]any{}
		}
		if name == "canvas_create" && args["kind"] == "image" {
			path, _ := args["path"].(string)
			key, err := images.Stash(path)
			if err != nil {
				sendJSON(w, map[string]any{"jsonrpc": "2.0", "id": id, "result": canvastools.ToolError(errText(err, "Couldn't read that image."))}, 200)
				return
			}
			next := make(map[string]any, len(args)+1)
			for k, v := range args {
				next[k] = v
			}
			next["image"] = key
			args = next
		}
		result = lv.CanvasCall(name, args)
	default:
		rpcError(w, id, -32601, "unknown method "+method)
		return
	}
	sendJSON(w, map[string]any{"jsonrpc": "2.0", "id": id, "result": result}, 200)
}
