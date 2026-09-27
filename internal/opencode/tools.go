package opencode

// OpenCode's tools, named and shaped as Claude's so the page renders them the same way (live/wire.go lists the ones
// it treats specially). A tool not listed keeps its name and input.
var toolNames = map[string]string{
	"read":      "Read",
	"edit":      "Edit",
	"write":     "Write",
	"bash":      "Bash",
	"shell":     "Bash", // OpenCode v2 renamed its shell tool from "bash"
	"glob":      "Glob",
	"grep":      "Grep",
	"list":      "LS",
	"webfetch":  "WebFetch",
	"websearch": "WebSearch",
	"task":      "Agent",
	"todowrite": "TodoWrite",
	"todoread":  "TodoRead",
	"question":  "AskUserQuestion",
}

// inputKeys renames OpenCode's camelCase input fields to Claude's.
var inputKeys = map[string]string{
	"filePath":   "file_path",
	"oldString":  "old_string",
	"newString":  "new_string",
	"replaceAll": "replace_all",
}

// tool maps an OpenCode tool call to Claude's name and input.
func tool(name string, input map[string]any) (string, map[string]any) {
	out := make(map[string]any, len(input))
	for k, v := range input {
		if nk, ok := inputKeys[k]; ok {
			k = nk
		}
		out[k] = v
	}
	if n, ok := toolNames[name]; ok {
		name = n
	}
	return name, out
}
