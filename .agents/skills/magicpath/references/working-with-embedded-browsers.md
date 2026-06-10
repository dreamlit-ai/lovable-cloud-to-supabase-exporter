# Working With Embedded Browsers - Keep a MagicPath Project Open as a Canvas

Use this reference when MagicPath runs through an external agent host that exposes an embedded browser, browser pane, or webview, such as Codex or Cursor when that capability is available.

## Purpose

A MagicPath project can become a persistent visual canvas beside the agent: the agent reasons across the user's local repository, assets, notes, skills, and tools while the user sees and selects work on the MagicPath canvas in the same workspace.

This guidance applies to **projects/files**, not individual design previews. Keep the browser focused on the project canvas. Only open an individual component or design in the embedded browser when the user explicitly asks to see that specific design.

Do not assume a named host always has an internal browser capability. Check the capabilities available in the current session and use this workflow only when the host can actually show or navigate that surface.

## When to use the embedded project canvas

Open or keep a MagicPath project in the host's embedded browser when:

- The user asks to create a new MagicPath project/file and will work on it visually.
- The user asks to build, edit, iterate on, or select designs in a named or currently open project.
- A new project has just been created and the requested next step is canvas authoring.
- The user asks to open a project in MagicPath inside Codex, Cursor, or the current agent.
- You need the user to make a selection on the canvas for a follow-up edit.

This should feel like one workflow: the agent works with local code and context while MagicPath remains visible as the visual canvas beside it.

When a request creates a new project and asks for any design work inside it, opening the project canvas is not an optional final preview step. Open it immediately after project creation and before starting the design work.

## Do not navigate to individual designs by default

- Creating, submitting, or editing a component does not require leaving the project canvas. The new or edited design appears in that project.
- Do not open each design or component in its own preview page after `code submit`.
- Do not replace the project canvas with a single-design preview merely to show progress.
- If the user explicitly asks to open a particular design or see it on its own, open it as requested.
- If the user asks for a single-design link, return the link without navigating away from the project canvas unless they also ask to open it.

## Resolve a project URL without opening an external browser

`view <projectId>` opens a project in the operating-system browser. In an agent host with an embedded browser, obtain the project URL without opening another window:

```bash
npx -y magicpath-ai share <projectId> -o json
```

The response includes the project URL:

```json
{
  "type": "project",
  "url": "https://www.magicpath.ai/files/<projectId>",
  "projectId": "<projectId>"
}
```

Navigate the host's embedded browser to the returned `url`. Prefer the URL returned by `share`; do not guess URL shapes or open a blank home page when the project is already known.

When no embedded browser is available, it cannot be controlled reliably, or the user explicitly wants their normal browser, use:

```bash
npx -y magicpath-ai view <projectId>
```

## Browser sign-in is separate from CLI sign-in

The CLI can be authenticated while the embedded browser is not. `whoami`, `create-project`, or `code submit` succeeding does not prove that the browser pane has a MagicPath login session.

The project URL returned by `share <projectId> -o json` is the intended canvas URL. If opening `/files/<projectId>` in the embedded browser redirects to the MagicPath home or sign-in flow:

1. Do not switch to a single-design preview as a workaround.
2. Tell the user that the embedded browser needs its own MagicPath sign-in.
3. Let the user sign in within that browser pane.
4. Navigate back to the same returned project URL after sign-in and continue work on the canvas.

## Project-canvas workflows

### Work in the active project

1. If the user refers to the project they have open, run `npx -y magicpath-ai active-project -o json`.
2. If it resolves to one project and it is not already visible in the embedded browser, run `share <project.id> -o json` and open that returned project URL there.
3. Keep that project visible while using `selection`, `code start`, and `code submit` for the user's requested work.
4. If multiple projects are active or none is active, resolve the intended project before navigating.

### Create a new project and begin visual work

1. Create the project with `npx -y magicpath-ai create-project --name "<name>" -o json`.
2. Read the returned `project.id`.
3. **Before authoring a design**, in an embedded-browser host run `npx -y magicpath-ai share <project.id> -o json` and open that project URL in the internal browser.
4. If the project URL redirects because the embedded browser is not signed in, complete the browser sign-in flow and reopen that same project URL.
5. If no embedded browser is available, run `npx -y magicpath-ai view <project.id>` only when user-facing project navigation is needed.
6. Continue the requested canvas workflow with `code start --project <project.id> ...`, keeping the project canvas visible for review and selection.
7. After `code submit`, verify progress on the open project canvas; do not navigate to a single-design preview unless the user expressly asks for it.

### The user asks for one design

1. If the user asks for a link to an individual design, resolve it with `npx -y magicpath-ai share <generatedName> -o json` and return its `url`.
2. Navigate the embedded browser to that individual design only if the user explicitly asks to open or see that design on its own.
3. Keep the project canvas available for continued creation and editing.

## Keep browser navigation quiet when

- Running `info`, `whoami`, `list-projects`, `list-components`, `list-teams`, `list-members`, `search`, `list-themes`, or `get-theme` only to make an internal decision.
- Using `inspect`, `add`, or other app-integration commands where the requested result is repository code rather than visible canvas work.
- Running automated checks or polling a `code submit` job before the project contains a viewable result.
- The project canvas is already visible and the next command does not require navigation.

## Host-specific handling

- **Codex:** If its Browser capability is available, show the MagicPath project there when the user will work with or review the canvas. This enables the native-canvas workflow: Codex and local context on one side, MagicPath on the other.
- **Cursor or another agent host:** Use its internal browser capability only when it is exposed in the current session. Do not invent commands or assume browser access.
- **No embedded browser:** Continue with the CLI and use `view <projectId>` for intentional project navigation.

## Boundaries

- Use the main `https://www.magicpath.ai` product surface returned by the CLI.
- Do not replace or reroute `magicpath-ai login`; authentication owns its browser flow.
- Do not confuse CLI authentication with the login session in the embedded browser pane.
- Keep one project canvas open rather than navigating to separate single-design previews as work is generated.
- Do not repeatedly refresh or navigate away from the user's active project while generation or selection work is in progress.
- Use `selection` and `active-project` to connect what the user is looking at in MagicPath back to the agent's next action.
