package lsp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
)

// JSON-RPC 2.0 as LSP frames it: a `Content-Length: N` header, a blank
// line, then N bytes of JSON.

// message is anything the editor sends: a request has an ID, a
// notification doesn't.
type message struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

func (m message) isRequest() bool { return len(m.ID) > 0 }

// response answers a request. Result is always written, null included, as
// the spec wants for a success.
type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result"`
}

type errorResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Error   *rpcError       `json:"error"`
}

type notification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string { return e.Message }

// Error codes the spec defines.
const (
	codeParseError           = -32700
	codeInvalidParams        = -32602
	codeMethodNotFound       = -32601
	codeInvalidRequest       = -32600
	codeServerNotInitialized = -32002
)

// conn reads messages from the editor and writes to it; writes are safe
// from any goroutine.
type conn struct {
	in  *bufio.Reader
	mu  sync.Mutex
	out io.Writer
}

func newConn(in io.Reader, out io.Writer) *conn {
	return &conn{in: bufio.NewReader(in), out: out}
}

// read is the next message's JSON. io.EOF means the editor closed the
// stream between messages; any other error means the stream can't be
// read any further.
func (c *conn) read() ([]byte, error) {
	length := -1
	for first := true; ; first = false {
		line, err := c.in.ReadString('\n')
		if err != nil {
			if err == io.EOF && first && line == "" {
				return nil, io.EOF
			}
			return nil, fmt.Errorf("reading a header: %w", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			return nil, fmt.Errorf("not a header: %q", line)
		}
		if strings.EqualFold(strings.TrimSpace(name), "Content-Length") {
			n, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil || n < 0 {
				return nil, fmt.Errorf("not a content length: %q", value)
			}
			length = n
		}
	}
	if length < 0 {
		return nil, fmt.Errorf("a message without a Content-Length header")
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(c.in, body); err != nil {
		return nil, fmt.Errorf("reading a message: %w", err)
	}
	return body, nil
}

func (c *conn) write(v any) error {
	body, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := fmt.Fprintf(c.out, "Content-Length: %d\r\n\r\n", len(body)); err != nil {
		return err
	}
	_, err = c.out.Write(body)
	return err
}

func (c *conn) reply(id json.RawMessage, result any) error {
	return c.write(response{JSONRPC: "2.0", ID: id, Result: result})
}

func (c *conn) replyError(id json.RawMessage, e *rpcError) error {
	if id == nil {
		id = json.RawMessage("null")
	}
	return c.write(errorResponse{JSONRPC: "2.0", ID: id, Error: e})
}

func (c *conn) notify(method string, params any) error {
	return c.write(notification{JSONRPC: "2.0", Method: method, Params: params})
}
