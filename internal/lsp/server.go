// Package lsp is `loadout lsp`: a language server for a config repo's HCL
// manifests, spoken over stdin and stdout to an editor.
package lsp

import (
	"encoding/json"
	"io"
	"log"
	"slices"
	"time"

	"github.com/josemiguelo/loadout/internal/version"
)

// server is one editor's session.
type server struct {
	conn *conn
	log  *log.Logger
	ws   *workspace

	initialized bool
	shutdown    bool
}

// Serve answers the editor on in and out until it says exit, logging to
// logw (the editor's LSP log). The result is the process's exit code: 0
// when exit came after shutdown, 1 otherwise.
func Serve(in io.Reader, out io.Writer, logw io.Writer) int {
	return serve(in, out, logw, 200*time.Millisecond)
}

// serve is Serve with changes checked after delay; 0 checks each at once.
func serve(in io.Reader, out io.Writer, logw io.Writer, delay time.Duration) int {
	s := &server{conn: newConn(in, out), log: log.New(logw, "loadout lsp: ", 0)}
	s.ws = newWorkspace(s.conn, s.log, delay)
	for {
		body, err := s.conn.read()
		if err != nil {
			if err != io.EOF {
				s.log.Print(err)
			}
			return 1
		}
		var m message
		if err := json.Unmarshal(body, &m); err != nil {
			s.log.Printf("not a message: %v", err)
			s.send(s.conn.replyError(nil, &rpcError{Code: codeParseError, Message: err.Error()}))
			continue
		}
		if m.Method == "exit" {
			if s.shutdown {
				return 0
			}
			return 1
		}
		s.handle(m)
	}
}

// handle answers one message: a request always gets a reply, a
// notification nobody handles is dropped.
func (s *server) handle(m message) {
	result, err := s.dispatch(m)
	if !m.isRequest() {
		if err != nil {
			s.log.Printf("%s: %v", m.Method, err)
		}
		return
	}
	if err != nil {
		e, ok := err.(*rpcError)
		if !ok {
			e = &rpcError{Code: codeInvalidParams, Message: err.Error()}
		}
		s.send(s.conn.replyError(m.ID, e))
		return
	}
	s.send(s.conn.reply(m.ID, result))
}

func (s *server) dispatch(m message) (any, error) {
	switch {
	case m.Method == "initialize":
		s.initialized = true
		return s.initialize(m.Params)
	case !s.initialized:
		if !m.isRequest() {
			return nil, nil
		}
		return nil, &rpcError{Code: codeServerNotInitialized, Message: "initialize first"}
	case s.shutdown && m.isRequest():
		return nil, &rpcError{Code: codeInvalidRequest, Message: "shutting down"}
	}
	switch m.Method {
	case "initialized":
		return nil, nil
	case "shutdown":
		s.shutdown = true
		return nil, nil
	case "textDocument/didOpen":
		var p struct {
			TextDocument struct {
				URI  string `json:"uri"`
				Text string `json:"text"`
			} `json:"textDocument"`
		}
		if err := json.Unmarshal(m.Params, &p); err != nil {
			return nil, err
		}
		s.ws.open(p.TextDocument.URI, p.TextDocument.Text)
		return nil, nil
	case "textDocument/didChange":
		var p struct {
			TextDocument   documentID `json:"textDocument"`
			ContentChanges []struct {
				Text string `json:"text"`
			} `json:"contentChanges"`
		}
		if err := json.Unmarshal(m.Params, &p); err != nil {
			return nil, err
		}
		// Full sync: the last change is the whole text.
		if n := len(p.ContentChanges); n > 0 {
			s.ws.change(p.TextDocument.URI, p.ContentChanges[n-1].Text)
		}
		return nil, nil
	case "textDocument/completion":
		var p struct {
			TextDocument documentID `json:"textDocument"`
			Position     position   `json:"position"`
		}
		if err := json.Unmarshal(m.Params, &p); err != nil {
			return nil, err
		}
		path, ok := pathOf(p.TextDocument.URI)
		if !ok {
			return completionList{Items: []completionItem{}}, nil
		}
		src, analysis := s.ws.snapshot(path)
		off := toOffset(src, p.Position, s.ws.encoding)
		return complete(src, off, p.Position.Line, s.ws.encoding, analysis), nil
	case "textDocument/didSave":
		s.ws.check()
		return nil, nil
	case "textDocument/didClose":
		var p struct {
			TextDocument documentID `json:"textDocument"`
		}
		if err := json.Unmarshal(m.Params, &p); err != nil {
			return nil, err
		}
		s.ws.close(p.TextDocument.URI)
		return nil, nil
	}
	if m.isRequest() {
		return nil, &rpcError{Code: codeMethodNotFound, Message: "unsupported method: " + m.Method}
	}
	return nil, nil
}

type initializeResult struct {
	Capabilities capabilities `json:"capabilities"`
	ServerInfo   serverInfo   `json:"serverInfo"`
}

type capabilities struct {
	PositionEncoding   string            `json:"positionEncoding"`
	TextDocumentSync   syncKind          `json:"textDocumentSync"`
	CompletionProvider completionOptions `json:"completionProvider"`
}

type completionOptions struct {
	TriggerCharacters []string `json:"triggerCharacters"`
}

type syncKind struct {
	OpenClose bool `json:"openClose"`
	Change    int  `json:"change"`
	Save      bool `json:"save"`
}

// syncFull is TextDocumentSyncKind.Full: every change sends the whole text.
const syncFull = 1

type documentID struct {
	URI string `json:"uri"`
}

type initializeParams struct {
	RootURI          string `json:"rootUri"`
	WorkspaceFolders []struct {
		URI string `json:"uri"`
	} `json:"workspaceFolders"`
	Capabilities struct {
		General struct {
			PositionEncodings []string `json:"positionEncodings"`
		} `json:"general"`
	} `json:"capabilities"`
}

type serverInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

func (s *server) initialize(params json.RawMessage) (any, error) {
	var p initializeParams
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
	}
	if slices.Contains(p.Capabilities.General.PositionEncodings, encodingUTF8) {
		s.ws.encoding = encodingUTF8
	}
	root := p.RootURI
	if len(p.WorkspaceFolders) > 0 {
		root = p.WorkspaceFolders[0].URI
	}
	dir, _ := pathOf(root)
	s.ws.setRoot(dir)
	return initializeResult{
		Capabilities: capabilities{
			PositionEncoding:   s.ws.encoding,
			TextDocumentSync:   syncKind{OpenClose: true, Change: syncFull, Save: true},
			CompletionProvider: completionOptions{TriggerCharacters: []string{"."}},
		},
		ServerInfo: serverInfo{Name: "loadout", Version: version.Version},
	}, nil
}

// send logs a failed write: the editor is gone, and the next read ends the session.
func (s *server) send(err error) {
	if err != nil {
		s.log.Printf("writing to the editor: %v", err)
	}
}
