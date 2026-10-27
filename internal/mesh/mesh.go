// Package mesh defines the adapter between Sulfur and a network of machines.
// An adapter owns discovery, authentication and transport. It presents files,
// sessions and hostkit operations through the API in docs/mesh-protocol.md.
package mesh

import "net/http"

// Version identifies the normalized API contract, independently of app releases.
// Version 1 includes the existing Phosphorus routes and message formats.
const Version = 1

// Kind adapts one type of mesh. An endpoint is opaque to Sulfur: a provider may
// accept an HTTP URL, a local daemon socket or a network identifier.
type Kind struct {
	Caps      []string
	Normalize func(endpoint string) (string, error)
	Reach     func(endpoint string) error
	Handler   func(endpoint string) http.Handler
}

// Info is additive metadata for the page. Old Phosphorus servers do not need
// to implement discovery or negotiation to remain usable.
type Info struct {
	Kind    string   `json:"kind"`
	Version int      `json:"version"`
	Caps    []string `json:"caps"`
}

func (k Kind) Info(name string) Info {
	return Info{Kind: name, Version: Version, Caps: append([]string{}, k.Caps...)}
}
