// Package canvastools holds the CANVAS_TOOLS schema Claude sees over MCP (list/read/create/update/link items on
// the canvas), and the small MCP tool-error shape used whenever a canvas call can't be carried out.
package canvastools

// Tools is CANVAS_TOOLS: the tool definitions served over MCP, and returned by tools/list.
var Tools = []map[string]any{
	{
		"name": "canvas_list",
		"description": "List what's on the user's canvas: the visual workspace this session lives on. Returns each item's id, kind " +
			"(session, note, doc, diagram, sketch, plan, snippet, image, file, files, run, git, github, agent), title, position and size in canvas " +
			`pixels, and whether it's collapsed. Your own session card is marked "you": true; items the user drew on ` +
			`(with the pen) are marked "drawnOn": true. Also lists the arrows drawn between items (from, to, label).`,
		"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
	},
	{
		"name": "canvas_read",
		"description": "Read one canvas item: its content as text (a note's text, a diagram's Mermaid source, a plan's markdown, a " +
			"snippet's text, a file node's path), plus a picture of it whenever the user drew on or over it, since drawings " +
			"never appear in the text. Sketches and images always come as a picture. Pass image: true to get a picture of any item. " +
			"Use the id from canvas_list (a prefix is enough).",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"id":    map[string]any{"type": "string"},
				"image": map[string]any{"type": "boolean", "description": "Also return a picture of the item as it looks"},
			},
			"required": []string{"id"},
		},
	},
	{
		"name": "canvas_create",
		"description": "Put something on the user's canvas, beside your session card (or beside another item). Use it when the user " +
			"asks to put, draw, pin or show something on the canvas, or when a diagram would genuinely help; not for normal " +
			"answers. Kinds: note (short text shown large on the canvas, like a sticky note), doc (a Markdown window: " +
			"headings, lists, tables, code blocks, ```mermaid diagrams and > [!NOTE] callouts render; for write-ups, plans, " +
			"summaries you want to leave on the canvas), diagram (Mermaid source; " +
			"drawn, and the user can edit it), snippet (a small window of code, text or command output), image (a PNG, JPEG, " +
			"GIF or WebP file you saved, e.g. a screenshot you took of the app with a headless browser: pass its path). " +
			"The item gets an " +
			"arrow from your session. Returns the new item's id.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"kind": map[string]any{"type": "string", "enum": []string{"note", "doc", "diagram", "snippet", "image"}},
				"text": map[string]any{
					"type":        "string",
					"description": "The note's text, the doc's Markdown, the diagram's Mermaid source, or the snippet's content (not for image)",
				},
				"path":  map[string]any{"type": "string", "description": "Image only: the image file, absolute or relative to the project"},
				"title": map[string]any{"type": "string", "description": "Window title (doc, diagram, snippet, image; a doc defaults to its first heading)"},
				"type":  map[string]any{"type": "string", "enum": []string{"code", "text", "output"}, "description": "Snippet only (default code)"},
				"lang":  map[string]any{"type": "string", "description": "Snippet code language, e.g. ts, py"},
				"near":  map[string]any{"type": "string", "description": "Place it beside this item id instead of your card"},
			},
			"required": []string{"kind"},
		},
	},
	{
		"name": "canvas_update",
		"description": "Change an existing item on the canvas in place: a diagram's Mermaid source (redrawn where it is), a note's " +
			"text, a doc's Markdown, a snippet's text; and a doc's, diagram's or snippet's title. When the user asks you to change something on the " +
			"canvas, update it rather than creating a new item. Read it first (canvas_read) to see its current content and " +
			"anything the user drew on it. Pass the whole new text, not a diff. Invalid Mermaid is refused and the diagram " +
			"stays as it was.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"id":    map[string]any{"type": "string", "description": "The item's id from canvas_list (a prefix is enough)"},
				"text":  map[string]any{"type": "string", "description": "The full new content"},
				"title": map[string]any{"type": "string", "description": "A new window title (diagram, snippet)"},
			},
			"required": []string{"id"},
		},
	},
	{
		"name": "canvas_link",
		"description": "Draw an arrow between two canvas items (from -> to), optionally labelled, to show how they relate. It stays " +
			"attached as they move. Use item ids from canvas_list.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"from":  map[string]any{"type": "string"},
				"to":    map[string]any{"type": "string"},
				"label": map[string]any{"type": "string", "description": "A short label shown on the arrow"},
			},
			"required": []string{"from", "to"},
		},
	},
}

func ToolError(text string) map[string]any {
	return map[string]any{"content": []map[string]any{{"type": "text", "text": text}}, "isError": true}
}
