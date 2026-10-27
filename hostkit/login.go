package hostkit

// What hostkit takes from the mesh it works on: a way to each host, logged in as the
// user, and the page's socket. hostkit never finds a host or holds a password itself.
// The mesh does: Phosphorus by its tailnet and the user's saved logins, another mesh by
// its own peers and keys. So the same work runs on any of them.

import (
	"errors"
	"strings"

	"golang.org/x/crypto/ssh"
)

// Login the user on a host: who they are there (a probe's cache key), and Dial, the
// mesh's ssh client to that host, already logged in as them
type Login struct {
	User string
	Dial func() (*ssh.Client, error)
	// Helper is the trusted command prefix used on this host. Providers supply
	// it, never requests from the page. Empty uses Sulfur's own binary.
	Helper string
	// Scope separates probe caches when two meshes have the same host/user names.
	Scope string
}

func (l Login) dial(host string) (*ssh.Client, error) {
	if l.Dial == nil {
		return nil, errors.New("no way to reach " + host)
	}
	return l.Dial()
}

func (l Login) helper() string {
	if l.Helper != "" {
		return l.Helper
	}
	return "sulfur"
}

// Socket a page's websocket, as LanguageSocket reads and writes it
type Socket interface {
	Read() (data []byte, binary bool, err error)
	TextBytes(b []byte) bool
	JSON(v any) bool
	Open() bool
	Close(code int)
}

// quote a word for sh
func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
