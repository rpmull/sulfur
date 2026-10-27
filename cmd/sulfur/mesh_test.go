package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestPhosphorusProxyPreservesSharedFilesAndLogin(t *testing.T) {
	var upstream *httptest.Server
	upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RequestURI() != "/api/files/host/list?share=home&path=shared%2Fproject" {
			t.Errorf("shared files request changed: %s", r.URL.RequestURI())
		}
		if r.Host != strings.TrimPrefix(upstream.URL, "http://") || r.Header.Get("Origin") != upstream.URL {
			t.Errorf("upstream origin/host: %s %s", r.Host, r.Header.Get("Origin"))
		}
		if r.Header.Get("Cookie") != "sid=existing-session" {
			t.Error("lost the existing mesh session")
		}
		w.Header().Set("Set-Cookie", "sid=renewed; Path=/; Domain=mesh.example; Secure; HttpOnly; SameSite=None")
		io.WriteString(w, `{"entries":[{"name":"shared-project"}]}`)
	}))
	defer upstream.Close()
	proxy := httptest.NewServer(meshProxy(upstream.URL, "/api/mesh"))
	defer proxy.Close()
	req, _ := http.NewRequest("GET", proxy.URL+"/api/mesh/api/files/host/list?share=home&path=shared%2Fproject", nil)
	req.Header.Set("Origin", proxy.URL)
	req.Header.Set("Cookie", "sid=existing-session")
	res, err := proxy.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil || string(body) != `{"entries":[{"name":"shared-project"}]}` {
		t.Fatalf("body %q: %v", body, err)
	}
	if cookie := res.Header.Get("Set-Cookie"); cookie != "sid=renewed; Path=/; HttpOnly; SameSite=Lax" {
		t.Fatalf("cookie %q", cookie)
	}
}

func TestPhosphorusProxyPreservesLiveSessionSockets(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RequestURI() != "/api/code/host?share=home&path=shared%2Fmain.go" {
			t.Errorf("live session request changed: %s", r.URL.RequestURI())
		}
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer ws.CloseNow()
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		typ, body, err := ws.Read(ctx)
		if err == nil {
			err = ws.Write(ctx, typ, body)
		}
		if err != nil {
			t.Error(err)
		}
	}))
	defer upstream.Close()
	proxy := httptest.NewServer(meshProxy(upstream.URL, "/api/mesh"))
	defer proxy.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, proxy.URL+"/api/mesh/api/code/host?share=home&path=shared%2Fmain.go", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{proxy.URL}}})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	edit := `{"t":"edit","op":[1,"x"]}`
	if err := ws.Write(ctx, websocket.MessageText, []byte(edit)); err != nil {
		t.Fatal(err)
	}
	_, body, err := ws.Read(ctx)
	if err != nil || string(body) != edit {
		t.Fatalf("edit %q: %v", body, err)
	}
}

func TestLegacyMeshConfigWorksOffline(t *testing.T) {
	oldPath, oldCfg, oldLink := *cfgAt, cfg, link
	t.Cleanup(func() { *cfgAt, cfg, link = oldPath, oldCfg, oldLink })
	*cfgAt = filepath.Join(t.TempDir(), "sulfur.json")
	if err := os.WriteFile(*cfgAt, []byte(`{"mode":"mesh","server":"http://remembered-host","servers":["http://remembered-host"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, link = config{}, nil
	loadConfig()
	if cfg.Mode != "local" || kindOf(cfg.Kind) != "phosphorus" || link == nil {
		t.Fatalf("legacy config: %#v, linked %v", cfg, link != nil)
	}
	if info := meshKinds["phosphorus"].Info("phosphorus"); info.Version != 1 || len(info.Caps) != 15 {
		t.Fatalf("capabilities: %#v", info)
	}
}
