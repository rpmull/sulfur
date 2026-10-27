// Package util contains Sulfur's local JSON, text and environment helpers.
package util

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

func Env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// Now in ms, Date.now()
func Now() int64 { return time.Now().UnixMilli() }

// Marshal JSON without HTML escaping, as JSON.stringify
func Marshal(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return []byte("null")
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

// UTF8 bytes as text, each invalid byte a U+FFFD, as Buffer.toString
func UTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	for len(b) > 0 {
		r, n := utf8.DecodeRune(b)
		if r == utf8.RuneError && n <= 1 {
			sb.WriteRune('�')
			b = b[1:]
			continue
		}
		sb.Write(b[:n])
		b = b[n:]
	}
	return sb.String()
}
