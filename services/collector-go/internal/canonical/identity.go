// Package canonical maps Collector OTLP/JSON payloads and deployment messages to the canonical
// records that the store and correlator read. It has no dependency on the store package.
package canonical

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"strings"
)

// Namespace is the fixed UUID namespace for every deterministic identity in the system.
const Namespace = "8f3c2a9e-5d1b-4f6a-b7c8-2e9d0a1b3c4d"

var namespaceBytes = mustNamespaceBytes(Namespace)

func mustNamespaceBytes(s string) []byte {
	b, err := hex.DecodeString(strings.ReplaceAll(s, "-", ""))
	if err != nil || len(b) != 16 {
		panic("canonical: invalid namespace constant")
	}
	return b
}

// EventID returns the RFC 4122 version 5 UUID of key in the fixed namespace (SHA-1 over the
// namespace bytes followed by the key bytes). The output is lower-case and hyphenated.
func EventID(key string) string {
	h := sha1.New()
	h.Write(namespaceBytes)
	h.Write([]byte(key))
	sum := h.Sum(nil)

	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x50 // version 5
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
