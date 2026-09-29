// Package canvastools holds the CANVAS_TOOLS schema Claude sees over MCP (list/read/create/update/link items on
// the canvas), and the small MCP tool-error shape used whenever a canvas call can't be carried out.
package canvastools

// Instructions go out in the MCP initialize answer. Claude Code puts them in the system prompt even while the tools
// themselves are deferred behind ToolSearch, so this is where the agent learns the canvas exists without being told.
const Instructions = "This session runs inside Drawa: the user is looking at a visual canvas where your session is one card " +
	"among notes, docs, diagrams, sketches, images and code windows. Use the canvas_* tools (load them with ToolSearch if deferred).\n" +
	"- When something is easier to see than to read (architecture, flows, state machines, before/after, UI screenshots, " +
	"comparisons), put it on the canvas when the user wants to see it, and offer to otherwise. Don't only describe it.\n" +
	"- Screenshots you take (e.g. of an app in a headless browser) go on the canvas with canvas_create kind image.\n" +
	"- Diagrams become kind diagram (Mermaid); long write-ups, plans and summaries become kind doc; short callouts become notes.\n" +
	"- When the user says \"this\", \"here\", \"what I drew\" or mentions the canvas, run canvas_list and canvas_read first: " +
	"pen drawings only show up in pictures.\n" +
	"- Change an existing item with canvas_update rather than adding a duplicate; show how items relate with canvas_link.\n" +
	"- Keep ordinary short answers in the chat."

// Tools is CANVAS_TOOLS: the tool definitions served over MCP, and returned by tools/list.
var Tools = []map[string]any{
	{
		"name": "canvas_list",
		"description": "List what's on the user's canvas: the visual workspace this session lives on. Returns each item's id, kind " +
			"(session, note, doc, diagram, sketch, plan, snippet, image, file, files, run, git, github, agent, preview, group; the user " +
			"calls a doc a scratchpad and a sketch a whiteboard; a preview is a project file they opened; a group is a named frame " +
			"holding other windows), title, position and size in canvas " +
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
			"asks to see, put, draw, pin or show something, or when a diagram, screenshot or write-up is clearer on the " +
			"canvas than in chat; keep short answers in chat. Kinds: note (short text shown large on the canvas, like a sticky note), doc (a Markdown window: " +
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
			"text, a doc's Markdown, a snippet's text (and its type and language); and a doc's, diagram's or snippet's title " +
			"(notes have none). When the user asks you to change something on the " +
			"canvas, update it rather than creating a new item. Read it first (canvas_read) to see its current content and " +
			"anything the user drew on it. Pass the whole new text, not a diff. Invalid Mermaid is refused and the diagram " +
			"stays as it was. An item the user is typing in right now is refused too: tell them what you'd change instead.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"id":    map[string]any{"type": "string", "description": "The item's id from canvas_list (a prefix is enough)"},
				"text":  map[string]any{"type": "string", "description": "The full new content"},
				"title": map[string]any{"type": "string", "description": "A new window title (doc, diagram, snippet)"},
				"type":  map[string]any{"type": "string", "enum": []string{"code", "text", "output"}, "description": "Snippet only: change its type"},
				"lang":  map[string]any{"type": "string", "description": "Snippet code language, e.g. ts, py"},
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
