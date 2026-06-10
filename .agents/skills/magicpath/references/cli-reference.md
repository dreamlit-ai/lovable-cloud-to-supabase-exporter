# MagicPath CLI Reference

> **IMPORTANT:** Always pass `-y` to skip interactive prompts when running from an agent context. Use `-o json` for structured output.

## Commands

### `info` — Project and auth context

```bash
magicpath-ai info              # human-readable
magicpath-ai info -o json      # structured JSON
```

Returns auth status, user info, teams, projects (personal + team), and CLI version. The `teams` array shows which teams the user belongs to and their role. Use `list-members` for full member details of a specific team.

### `login` — Authenticate

```bash
magicpath-ai login                    # one-click browser login (auto-completes)
magicpath-ai login --code <code>      # exchange auth code directly (headless fallback)
```

Opens the browser and completes login automatically when the user authorizes.

| Flag            | Description                                                        |
| --------------- | ------------------------------------------------------------------ |
| `--code <code>` | Exchange a browser authorization code directly (headless fallback) |

### `whoami` — Check authentication

```bash
magicpath-ai whoami
magicpath-ai whoami -o json
```

### `list-teams` — List teams

```bash
magicpath-ai list-teams
magicpath-ai list-teams -o json
```

Lists all teams the user belongs to, with their role in each.

JSON output: `{ teams: [{ id, name, role }] }`

### `list-members` — List members of a team

```bash
magicpath-ai list-members --team "Acme Inc"
magicpath-ai list-members --team "Acme Inc" -o json
magicpath-ai list-members --team <teamId> -o json
```

Lists all members of the specified team. The `--team` flag is required and accepts a name (case-insensitive) or ID.

JSON output: `{ team: { id, name }, members: [{ id, displayName, email, role }] }`

Use `list-members` to resolve a person's name to their user ID, then use `--created-by <userId>` on `list-components` to find their work.

### `search` — Search components across all projects

```bash
magicpath-ai search "input"
magicpath-ai search "button" -o json
magicpath-ai search "card" --limit 5
magicpath-ai search "header" --team "Acme Inc" -o json
magicpath-ai search "nav" --personal -o json
```

Searches component names (case-insensitive substring match) across all accessible projects (personal + team). Returns matches with project and workspace context. Each result includes `previewImageUrl` — use `list-components` or search results to get preview images when visual context is needed.

| Flag                | Description                        | Default |
| ------------------- | ---------------------------------- | ------- |
| `--limit <n>`       | Max results                        | 20      |
| `--team <nameOrId>` | Search only within a specific team | all     |
| `--personal`        | Search only personal projects      | false   |

JSON output includes `ownerType` (`"personal"` or `"team"`) and `ownerName` on each result.

### `list-projects` — List all projects

```bash
magicpath-ai list-projects
magicpath-ai list-projects -o json
magicpath-ai list-projects -o json --limit 10
magicpath-ai list-projects --team "Acme Inc" -o json
magicpath-ai list-projects --personal -o json
```

By default, lists all accessible projects (personal + all teams). Use `--team` or `--personal` to filter.

| Flag                | Description                            | Default |
| ------------------- | -------------------------------------- | ------- |
| `--limit <n>`       | Max results                            | all     |
| `--offset <n>`      | Skip first N results                   | 0       |
| `--team <nameOrId>` | Filter to a specific team (name or ID) | all     |
| `--personal`        | Show only personal projects            | false   |

JSON output: `{ projects, pagination: { total, limit, offset, hasMore } }`. Each project includes:

- `ownerType` (`"personal"` or `"team"`) and `ownerName` (user email or team name)
- `createdBy` (object or null) — `{ id, displayName }` of the user who created this project

### `create-project` — Create a new project

```bash
magicpath-ai create-project --name "My Stuff" -o json
magicpath-ai create-project --name "My Stuff" --team "Acme Inc" -o json
magicpath-ai create-project --team "Acme Inc" -o json   # auto-generated name
```

Creates a project in the user's personal workspace, or in a team if `--team` is passed. With `--team`, the user must be a member of that team.

| Flag                | Description                                  | Default                    |
| ------------------- | -------------------------------------------- | -------------------------- |
| `--name <name>`     | Project name                                 | auto-generated placeholder |
| `--team <nameOrId>` | Create the project in this team (name or ID) | personal                   |

JSON output: `{ project }` — the same project shape returned by `list-projects` (includes `id`, `name`, `ownerType`, `ownerName`, `visibility`, etc.). Use `project.id` as the `--project` argument for `code start` to add the first component.

Visibility is set automatically: personal projects default to `PRIVATE`, team projects default to `SHARED`.

### `list-components` — List components in a project

```bash
magicpath-ai list-components <projectId>
magicpath-ai list-components <projectId> -o json
magicpath-ai list-components <projectId> -o json --limit 20
magicpath-ai list-components <projectId> -o json --after <lastId>
magicpath-ai list-components <projectId> --created-by <userId> -o json
magicpath-ai list-components <projectId> --created-by <userId> --sort-by createdAt --order desc -o json
```

Uses cursor-based pagination. To get the next page, pass `pagination.lastId` as `--after`.

| Flag                    | Description                                         | Default |
| ----------------------- | --------------------------------------------------- | ------- |
| `--limit <n>`           | Max results per page                                | 100     |
| `--after <id>`          | Cursor: fetch after this component ID               | none    |
| `--sort-by <field>`     | Sort by `name` or `createdAt`                       | name    |
| `--order <dir>`         | Sort direction: `asc` or `desc`                     | asc     |
| `--created-by <userId>` | Filter to components created or edited by this user | none    |

JSON output: `{ components, pagination: { limit, hasNext, lastId } }`. Each component includes:

- `previewImageUrl` (string or null) — a screenshot of the component's latest revision
- `lastEditedBy` (object or null) — `{ id, displayName }` of the user who last edited this component

### `list-themes` — List all themes (design systems)

```bash
magicpath-ai list-themes
magicpath-ai list-themes -o json
magicpath-ai list-themes --team "Acme Inc" -o json
```

Lists design systems (themes) for the current user, or for a specific team with `--team`.

| Flag                | Description                     | Default  |
| ------------------- | ------------------------------- | -------- |
| `--team <nameOrId>` | List themes for a specific team | personal |

JSON output: `{ themes: [{ id, name, isPublic, createdAt, updatedAt }] }`

### `get-theme` — Get a theme definition

```bash
magicpath-ai get-theme <themeId>
magicpath-ai get-theme <themeId> -o json
magicpath-ai get-theme "My Brand Theme" -o json    # lookup by name
magicpath-ai get-theme "Brand" --team "Acme Inc" -o json  # lookup in team
```

Fetches the full theme definition including CSS variables, fonts, and styling prompt. Accepts a numeric ID or a theme name (case-insensitive match). Use `--team` to look up themes within a specific team.

| Flag                | Description                          | Default  |
| ------------------- | ------------------------------------ | -------- |
| `--team <nameOrId>` | Look up theme within a specific team | personal |

JSON output: `{ id, name, theme: { light: { "--var": "value", ... }, dark: { ... } }, defaultTheme, prompt?, fonts?, version }`

Key fields for agents:

- `theme.light` / `theme.dark` — CSS variable maps to apply to components
- `prompt` — Natural language styling instructions from the designer (e.g., "use rounded corners, prefer shadows over borders")
- `fonts` — Font metadata with source (`google` or `custom`) and weight URLs
- `defaultTheme` — Whether the theme defaults to `"light"` or `"dark"`

### `view` — Open a component or project

```bash
magicpath-ai view <generatedName>              # component preview
magicpath-ai view-component <generatedName>    # alias
magicpath-ai view <projectId>                  # open the project
```

Opens the target in the default browser. In JSON mode, returns the URL without opening. The argument is a component `generatedName` (e.g. `wispy-river-5234`) or a project `id` (numeric) — a numeric id opens the project, anything else opens the component preview.

### `share` — Get a shareable URL

```bash
magicpath-ai share <generatedName>
magicpath-ai share <generatedName> -o json     # { type: "component", url, generatedName }
magicpath-ai share <projectId> -o json         # { type: "project", url, projectId }
```

Prints the URL to stdout (one line). Doesn't open a browser — use `view` if you want that. Accepts the same identifiers as `view`: a component `generatedName` (from `search`, `list-components`, `selection`, or the `code` flow) or a project `id` (from `list-projects`, `create-project`, or `active-project`).

### `inspect` — View component source code

```bash
magicpath-ai inspect <generatedName>              # human-readable with file contents
magicpath-ai inspect <generatedName> -o json      # structured JSON with source code
```

Shows the component's source code, dependencies, and import info without installing anything. This is read-only — no files are written, no package.json is required.

`inspect` works in any project type. For non-React projects (Swift, Python, etc.), use `inspect` to read MagicPath component source code as a reference for recreating the component in your target language.

| Flag      | Short | Description          | Default |
| --------- | ----- | -------------------- | ------- |
| `--debug` | `-d`  | Enable debug logging | false   |

**JSON output** includes `{ component, generatedName, files: [{ path, name, content }], dependencies, importStatement?, usage? }`.

### `add` — Add a component to your project

> **IMPORTANT:** Only use `add` in React/TypeScript projects where you intend to import the component afterward. For non-JS projects, use `magicpath-ai inspect` to read source code and translate it. After adding, always import and use the component — never add and then manually replicate its styles.

```bash
magicpath-ai add <generatedName>
magicpath-ai add <generatedName> -y              # skip prompts
magicpath-ai add <generatedName> --dry-run       # preview file list only
magicpath-ai add <generatedName> -y --overwrite  # replace existing
```

| Flag            | Short | Description                       | Default                  |
| --------------- | ----- | --------------------------------- | ------------------------ |
| `--yes`         | `-y`  | Skip confirmation prompts         | false                    |
| `--overwrite`   |       | Overwrite existing files          | false                    |
| `--path <path>` | `-p`  | Custom component path             | src/components/magicpath |
| `--dry-run`     |       | Preview file list without writing | false                    |
| `--debug`       | `-d`  | Enable debug logging              | false                    |

**JSON output** (`-o json`) automatically implies `-y` (no prompts).

### `list-installed` — List installed MagicPath components

```bash
magicpath-ai list-installed
magicpath-ai list-installed -o json
magicpath-ai list-installed --path src/components/custom
```

Lists MagicPath components already installed in the current project by scanning the components directory. Useful for checking what's already been added before installing new components.

| Flag            | Short | Description                 | Default                  |
| --------------- | ----- | --------------------------- | ------------------------ |
| `--path <path>` | `-p`  | Custom components directory | src/components/magicpath |

JSON output: `{ components: [{ name, folder, path, files, exportName, importStatement }], total, componentsPath }`

### `selection` — Get current canvas selection

```bash
magicpath-ai selection
magicpath-ai selection -o json
```

Returns the component(s) and image(s) currently selected in the MagicPath web app canvas, along with the project(s) the user has open. Returns empty `components`/`images` if the user has nothing of that type selected, and empty `projects` if no canvas is open.

JSON output: `{ projects: [{ id, name, ownerType, ownerName }], components: [{ id, name, generatedName, clientId, projectId, projectName }], images: [{ id, shapeId, name, projectId, projectName, width, height }] }`

Notes:

- `projects` is the same shape returned by `active-project` — calling `selection` gives you both signals in one round-trip.
- `components` may be empty while `images` or `projects` are non-empty. Use that to decide whether to start a code session with selected image context, or fall back to listing/searching components.
- If only the open project is needed (not the selection), prefer `active-project` — it is faster than `selection`.

### `active-project` — Get the project(s) the user currently has open

```bash
magicpath-ai active-project
magicpath-ai active-project -o json
```

Returns the project(s) the user currently has open in the MagicPath web app. Use this when you need the user's working project but no specific component has been selected. Returns an empty list if the user has no active canvas session.

JSON output: `{ projects: [{ id, name, ownerType, ownerName }] }`

Notes:

- Multiple projects can be returned if the user has multiple tabs open.
- `active-project` is the lighter of the two commands — it returns only the open project(s), while `selection` returns those _plus_ any selected components and is more expensive. Prefer `selection` when the user references a component; use `active-project` when they only need the project.
- If a project is open but cannot be resolved against the user's accessible projects, the entry is returned with `name`, `ownerType`, and `ownerName` set to `null` and only the `id` populated.

### `code` — Create/edit canvas components from local code

The `code` subcommands let an external agent author or edit a MagicPath canvas component's source files locally, then submit them back to the platform. This is unrelated to `add`/`inspect`, which install reusable component source into an application.

`code start` is the stateful entrypoint for both create and edit. With `--project`, it creates a pending component revision and writes a scaffolded Component Forge app. With `--component`, it creates or reuses a pending edit revision and writes editable source files. `code context` is read-only and does not create a revision, canvas presence, or submit manifest. `code submit` uploads changed files and waits for the build when `--wait` is passed.

All stateful `code` sessions operate against a working directory and persist state in `<dir>/magicpath-code.json` (written by `start`, `create`, and successful `submit`; read by `submit`).

#### Editable file boundary

The `code` API only accepts full-file replacements for:

- `src/App.tsx`
- `src/index.css`
- `src/components/generated/**`
- `assets/**` for temporary image assets only

Image files in `<dir>/assets/` are staging inputs. The backend uploads them to stable public asset URLs, rewrites TSX/CSS references, and removes the staging folder before build. Reference assets from component code or CSS with paths such as `../../../assets/hero.png`, `/assets/hero.png`, or `url("../../assets/hero.png")`. Do not inline `data:image/...;base64,...` in source files.

When image shapes are selected on the canvas before `code start`, JSON output may include `selectedImages`. Each selected image has a short-lived `accessUrl` plus a local `assetPath`; the CLI downloads the URL into that `assets/selected/**` path. Use the local `assetPath` in source, not the expiring `accessUrl`.

It does **not** accept dependency installation, `package.json` edits, `src/main.tsx`, Vite config changes, lockfile edits, raw patches, or arbitrary repo files.

#### Tailwind v4 requirements

- Keep `@import 'tailwindcss';` in `src/index.css`.
- Do not use `@tailwind base;`, `@tailwind components;`, or `@tailwind utilities;`.
- Do not remove `@theme inline { ... }`, `:root`, or `.dark` token blocks.
- Append custom utilities or theme additions to `src/index.css`; do not replace the whole file.
- There is no `tailwind.config.js`; configuration lives in `src/index.css`.

#### `code start` — Start a pending create or edit session before writing code

```bash
npx -y magicpath-ai code start --project <projectId> --dir ./mp-new --name "Hero Card" --width 960 --height 640 -o json
npx -y magicpath-ai code start --component <componentId> --dir ./mp-work -o json
```

For creates, creates a component and pending revision on the canvas immediately, enables external-agent canvas presence (Liveblocks cursor), and **scaffolds the starting file structure** into `<dir>`:

- `magicpath-code.json` — manifest with component/revision IDs
- `src/App.tsx` — pre-wired slim entry file that imports and renders the top-level component from `src/components/generated/<ComponentName>`
- `src/index.css` — Component Forge Tailwind v4 setup with `@import 'tailwindcss';`, `@theme inline`, token definitions, base layer, and fallback image styles
- `src/components/generated/<ComponentName>.tsx` — stub named-export component ready to fill in

The component filename is derived from `--name` (PascalCase, e.g. `"Hero Card"` → `HeroCard`). JSON output includes `scaffoldedPaths` listing the files that were written.

For edits, creates or reuses one pending edit revision for the component, enables external-agent canvas presence, writes the editable source files into `<dir>`, and writes `magicpath-code.json`. Run this before generating files for a new or existing canvas component.

If selected canvas images were available, `code start` also writes them into `<dir>/assets/selected/` and includes `selectedImages` in the JSON result and manifest. Those files are normal temporary assets and will be uploaded/referenced durably on `code submit`.

| Flag                        | Description                                                                                | Default                    |
| --------------------------- | ------------------------------------------------------------------------------------------ | -------------------------- |
| `--project <projectId>`     | Target MagicPath project ID for create. Use exactly one of `--project` or `--component`.   | —                          |
| `--component <componentId>` | Existing MagicPath component ID for edit. Use exactly one of `--project` or `--component`. | —                          |
| `--revision <revisionId>`   | Revision to start editing. Defaults to the component's selected revision.                  | selected revision          |
| `--dir <dir>`               | Working directory to initialize                                                            | `.`                        |
| `--name <name>`             | Component name                                                                             | `External Agent Component` |
| `--width <px>`              | Canvas width for new components. Use with `--height`; only valid with `--project`.         | default placement width    |
| `--height <px>`             | Canvas height for new components. Use with `--width`; only valid with `--project`.         | default placement height   |

#### `code context` — Fetch existing component source read-only

```bash
npx -y magicpath-ai code context <componentId> --dir ./mp-work -o json
```

Writes `src/App.tsx`, `src/index.css`, and `src/components/generated/**` into `<dir>` for inspection only. It does **not** create a pending revision, does **not** show canvas presence, and does **not** write `magicpath-code.json`. Use `code start --component <componentId>` before submitting edits.

| Flag                      | Description                                                       | Default           |
| ------------------------- | ----------------------------------------------------------------- | ----------------- |
| `--dir <dir>`             | Working directory to write into                                   | `.`               |
| `--revision <revisionId>` | Revision to fetch. Defaults to the component's selected revision. | selected revision |

#### `code submit` — Submit local edits

```bash
npx -y magicpath-ai code submit --dir ./mp-work --width 960 --height 640 --wait -o json
```

Reads `magicpath-code.json`, computes both the set of changed editable files and any files that were removed from `<dir>` since the last `start`/successful `submit`, and submits them together (changes as full-file replacements, removals as `deletedPaths`). Prints the resulting job/revision. Use `--wait` when the agent should fix build failures in the same turn.

| Flag              | Description                                        | Default   |
| ----------------- | -------------------------------------------------- | --------- |
| `--dir <dir>`     | Working directory containing `magicpath-code.json` | `.`       |
| `--wait`          | Wait for the build job to finish                   | false     |
| `--interval <ms>` | Polling interval when `--wait` is set              | `2000`    |
| `--width <px>`    | Updated canvas width. Use with `--height`.         | unchanged |
| `--height <px>`   | Updated canvas height. Use with `--width`.         | unchanged |

To delete a file, just remove it from `<dir>` before running `submit` — the deletion is inferred from the manifest baseline. Deletion propagation is active only in edit mode; in create mode, simply don't write the file. The JSON output includes `deletedPaths: [...]` listing what was removed.

If no editable files have changed, nothing has been deleted, and no dimensions were provided, returns `{ status: "unchanged", componentId, revisionId }` without submitting.

#### `code create` — Create a new component from already-written files (convenience)

```bash
npx -y magicpath-ai code create --project <projectId> --dir ./mp-new --name "Hero Card" --wait -o json
```

Convenience wrapper: internally runs `code start` and then uploads the files from `<dir>`. **Prefer explicit `code start` followed by `code submit`** — the split gives better canvas feedback (the pending component is visible while the agent is still writing code). `<dir>` must include `src/App.tsx`.

| Flag                    | Description                                              | Default                    |
| ----------------------- | -------------------------------------------------------- | -------------------------- |
| `--project <projectId>` | Target MagicPath project ID (required)                   | —                          |
| `--dir <dir>`           | Working directory containing `src/App.tsx`               | `.`                        |
| `--name <name>`         | Component name                                           | `External Agent Component` |
| `--wait`                | Wait for the build job to finish                         | false                      |
| `--width <px>`          | Canvas width for the new component. Use with `--height`. | default placement width    |
| `--height <px>`         | Canvas height for the new component. Use with `--width`. | default placement height   |

#### `code status` — Poll an external-agent build job

```bash
npx -y magicpath-ai code status <jobId> -o json
```

Returns `pending`, `processing`, `completed`, `failed`, or `cancelled`. Failed jobs include sanitized build diagnostics when available.

### `image` — List and add images on a project canvas

Standalone images that live directly on a project's canvas (alongside components). This is distinct from the `assets/` files in the `code` flow, which are build inputs for a single component — `image` operates on the project canvas itself.

#### `image list` — List the images on a project canvas

```bash
npx -y magicpath-ai image list <projectId> -o json
```

JSON output: `{ images: [{ id, name, url, position: { x, y, z, width, height }, createdAt, updatedAt }] }`. The `url` is a public image URL — download it to visually inspect what an image looks like (the same way `previewImageUrl` is used for components). Use this to "see" the images already present in a project.

#### `image add` — Add an image to a project canvas

```bash
npx -y magicpath-ai image add <projectId> ./hero.png -o json
npx -y magicpath-ai image add <projectId> https://example.com/hero.png --name "Hero" -o json
```

Uploads a local image file or a remote URL to the project and places it on the canvas, where it appears automatically. Requires editor access to the project.

| Flag            | Description            | Default                      |
| --------------- | ---------------------- | ---------------------------- |
| `--name <name>` | Display name           | the file name                |
| `--x <x>`       | Canvas x position      | `0`                          |
| `--y <y>`       | Canvas y position      | `0`                          |
| `--width <px>`  | Width in canvas units  | the image's intrinsic width  |
| `--height <px>` | Height in canvas units | the image's intrinsic height |

Width and height default to the image's real pixel dimensions so it isn't stretched; pass `--width`/`--height` only to override. JSON output: `{ image: { id, name, url, position } }`.
