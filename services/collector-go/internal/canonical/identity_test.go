package canonical

import "testing"

func TestEventIDIsStableAndUUIDv5(t *testing.T) {
	a := EventID("trace|0af7651916cd43dd8448eb211c80319c|b7ad6b7169203331")
	b := EventID("trace|0af7651916cd43dd8448eb211c80319c|b7ad6b7169203331")
	if a != b {
		t.Fatal("not stable")
	}
	if len(a) != 36 || a[14] != '5' {
		t.Fatalf("not a v5 UUID: %s", a)
	}
}

func TestEventIDDiffersByKey(t *testing.T) {
	if EventID("trace|x|y") == EventID("trace|x|z") {
		t.Fatal("collision")
	}
}

// The expected value was computed independently with Python's uuid.uuid5 over the same namespace.
func TestEventIDMatchesReferenceUUIDv5(t *testing.T) {
	const want = "f9167183-9a1e-5218-82bc-4df30ad543e6"
	if got := EventID("trace|0af7651916cd43dd8448eb211c80319c|b7ad6b7169203331"); got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}
