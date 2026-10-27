package hostkit

import "testing"

func TestHelpersAreSelectedPerConnection(t *testing.T) {
	phosphorus := Login{Helper: "phosphorus"}
	overlay := Login{}
	custom := Login{Helper: "/opt/sulfur/bin/sulfur"}
	for _, login := range []Login{phosphorus, overlay, custom, phosphorus} {
		want := login.Helper
		if want == "" {
			want = "sulfur"
		}
		if got := login.helper(); got != want {
			t.Fatalf("helper %q, want %q", got, want)
		}
	}
}
