package main

// The kinds of mesh Sulfur links beside this computer (docs/mesh-protocol.md). A mesh
// gives Sulfur more machines, and whatever else it has: each kind says what it gives
// (its caps, reported to the page in /api/sidecar/info) and answers its machines' calls
// under /api/mesh/. Phosphorus is the first: its server answers every call itself, so
// its handler is a proxy to it. A kind for an overlay network (Tailscale, Headscale,
// NetBird, ZeroTier, Nebula) is Sulfur's own handler instead: the peers from the
// network's status, files, terminals and hostkit over ssh to each.

import (
	"net/http"
	"net/url"

	"github.com/pmghartman/sulfur/internal/mesh"
)

var meshKinds = map[string]mesh.Kind{
	"phosphorus": {
		Caps: []string{"hosts", "files", "home", "sessions", "terminals", "toolchains", "runs", "languages",
			"git", "sqlite", "vsx", "people", "agents", "models", "forgejo"},
		Normalize: func(server string) (string, error) {
			u, err := serverURL(server)
			if err != nil {
				return "", err
			}
			return u.String(), nil
		},
		Reach: func(server string) error {
			u, err := url.Parse(server)
			if err != nil {
				return err
			}
			return reach(u)
		},
		Handler: func(server string) http.Handler { return meshProxy(server, "/api/mesh") },
	},
}

// kindOf a mesh's kind as remembered or asked for: none is Phosphorus, the one there was
func kindOf(kind string) string {
	if kind == "" {
		return "phosphorus"
	}
	return kind
}
