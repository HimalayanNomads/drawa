package live

import "os/exec"

// Write answers one prompt about text with a backend's OneShot: commit messages and PR descriptions. kind picks
// the backend; "" means the first installed one that can, Default first. (true, the reply) or (false, why not).
func Write(kind, prompt, text string) (bool, string) {
	if kind != "" {
		k, ok := Lookup(kind)
		if !ok || k.OneShot == nil {
			return false, "No agent called " + kind + " can write this."
		}
		if _, err := exec.LookPath(k.Bin); err != nil {
			return false, k.Label + " isn't installed: " + k.Install
		}
		return k.OneShot(prompt, text)
	}
	for _, name := range append([]string{Default}, Names()...) {
		k, ok := Lookup(name)
		if !ok || k.OneShot == nil {
			continue
		}
		if _, err := exec.LookPath(k.Bin); err == nil {
			return k.OneShot(prompt, text)
		}
	}
	return false, "No agent CLI is installed to write this."
}
