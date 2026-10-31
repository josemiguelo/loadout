package lsp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
)

// A session is the editor's messages in, Serve's replies and exit code out.

func frame(msgs ...string) string {
	var b strings.Builder
	for _, m := range msgs {
		fmt.Fprintf(&b, "Content-Length: %d\r\n\r\n%s", len(m), m)
	}
	return b.String()
}

// session runs Serve over in and is the replies it wrote, decoded, its exit
// code and its log.
func session(t *testing.T, in string) ([]map[string]any, int, string) {
	t.Helper()
	var out, logs bytes.Buffer
	code := serve(strings.NewReader(in), &out, &logs, 0)
	c := newConn(&out, io.Discard)
	var replies []map[string]any
	for {
		body, err := c.read()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Serve wrote a broken frame: %v\n%s", err, out.String())
		}
		var m map[string]any
		if err := json.Unmarshal(body, &m); err != nil {
			t.Fatalf("Serve wrote a broken message: %v: %s", err, body)
		}
		replies = append(replies, m)
	}
	return replies, code, logs.String()
}

const (
	initialize  = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`
	initialized = `{"jsonrpc":"2.0","method":"initialized","params":{}}`
	shutdown    = `{"jsonrpc":"2.0","id":2,"method":"shutdown"}`
	exit        = `{"jsonrpc":"2.0","method":"exit"}`
)

func errorCode(t *testing.T, reply map[string]any) float64 {
	t.Helper()
	e, ok := reply["error"].(map[string]any)
	if !ok {
		t.Fatalf("not an error: %v", reply)
	}
	return e["code"].(float64)
}

func TestASessionInitializesAndShutsDownCleanly(t *testing.T) {
	replies, code, _ := session(t, frame(initialize, initialized, shutdown, exit))
	if code != 0 || len(replies) != 2 {
		t.Fatalf("code %d, replies %v", code, replies)
	}
	info := replies[0]["result"].(map[string]any)["serverInfo"].(map[string]any)
	if info["name"] != "loadout" || replies[0]["id"] != 1.0 {
		t.Errorf("initialize: %v", replies[0])
	}
	result, ok := replies[1]["result"]
	if !ok || result != nil || replies[1]["id"] != 2.0 {
		t.Errorf("shutdown: %v", replies[1])
	}
}

func TestExitWithoutShutdownIsAFailure(t *testing.T) {
	if _, code, _ := session(t, frame(initialize, exit)); code != 1 {
		t.Errorf("code %d", code)
	}
}

func TestTheEditorClosingTheStreamIsAFailure(t *testing.T) {
	if _, code, _ := session(t, frame(initialize)); code != 1 {
		t.Errorf("code %d", code)
	}
}

func TestAnUnknownRequestIsAnErrorAndAnUnknownNotificationNothing(t *testing.T) {
	replies, _, _ := session(t, frame(initialize,
		`{"jsonrpc":"2.0","method":"$/someNotification","params":{}}`,
		`{"jsonrpc":"2.0","id":"x","method":"textDocument/rename","params":{}}`,
		shutdown, exit))
	if len(replies) != 3 || replies[1]["id"] != "x" || errorCode(t, replies[1]) != codeMethodNotFound {
		t.Errorf("replies: %v", replies)
	}
}

func TestARequestBeforeInitializeIsRefused(t *testing.T) {
	replies, _, _ := session(t, frame(shutdown, exit))
	if len(replies) != 1 || errorCode(t, replies[0]) != codeServerNotInitialized {
		t.Errorf("replies: %v", replies)
	}
}

func TestARequestAfterShutdownIsRefused(t *testing.T) {
	replies, code, _ := session(t, frame(initialize, shutdown, `{"jsonrpc":"2.0","id":3,"method":"textDocument/hover"}`, exit))
	if code != 0 || len(replies) != 3 || errorCode(t, replies[2]) != codeInvalidRequest {
		t.Errorf("code %d, replies: %v", code, replies)
	}
}

func TestBrokenJSONIsAParseErrorAndTheSessionGoesOn(t *testing.T) {
	replies, code, logs := session(t, frame(initialize, `{"jsonrpc":`, shutdown, exit))
	if code != 0 || len(replies) != 3 || replies[1]["id"] != nil || errorCode(t, replies[1]) != codeParseError || !strings.Contains(logs, "not a message") {
		t.Errorf("code %d, replies %v, logs %q", code, replies, logs)
	}
}

func TestABrokenHeaderEndsTheSession(t *testing.T) {
	for name, in := range map[string]string{
		"no colon":            "Content-Length 10\r\n\r\n",
		"no length":           "Content-Type: x\r\n\r\n{}",
		"length not a number": "Content-Length: ten\r\n\r\n",
		"body cut short":      "Content-Length: 99\r\n\r\n{}",
	} {
		t.Run(name, func(t *testing.T) {
			replies, code, logs := session(t, frame(initialize)+in)
			if code != 1 || len(replies) != 1 || logs == "" {
				t.Errorf("code %d, replies %v, logs %q", code, replies, logs)
			}
		})
	}
}
