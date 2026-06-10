# Working With Repositories — Bring an Existing Codebase Into MagicPath

> **IMPORTANT:** This flow is the **inverse** of `add`/`inspect`. With `add`/`inspect` the source of truth is the MagicPath registry and the destination is the user's app. Here the **source of truth is the user's repository** and the **destination is the MagicPath canvas**. You recreate the repo's UI as a canvas component using the `code start` → `code submit` authoring flow. Do **not** use `add`, `inspect`, or `code context` for this — they are for other workflows (see the boundaries section below).

This reference tells an external agent (MagicPath's own agent, Claude Code, Codex, Cursor, etc.) exactly what to do when the user wants to take UI that already exists in a Git repository — local or online — and reproduce it faithfully as a React component on their MagicPath canvas.

## When this applies (triggers)

Reach for this reference when the user points at existing code and asks to get it onto the canvas. Examples:

- "Bring the sidebar of my app into MagicPath."
- "Render this project in MagicPath." / "Import my repo." / "Recreate my landing page in MagicPath."
- "Design from my existing dashboard." / "Pull my `<Header />` into a MagicPath design."
- Any message that pairs a **local path** (e.g. `~/code/acme-web`) or an **online repo URL** (GitHub/GitLab/Bitbucket) with MagicPath intent.

If the user is instead asking to install a MagicPath registry component into their app, that is the `add`/`inspect` flow — not this one.

## The mental model

A MagicPath canvas component is a single, self-contained, interactive React + Tailwind v4 mini-app (see the skill's **Design Defaults**). Your job is to read the relevant slice of the repo, understand both its **visual output** and its **behavior**, and reproduce that as faithfully as possible inside the canvas authoring template — translating whatever framework and styling system the repo uses into the canvas's React + Tailwind v4 conventions.

Fidelity is the goal: the canvas result should look like the same product, not a reinterpretation of it.

---

## Phase 0 — Get the code

**Local repository.** Confirm the path with the user if it isn't explicit. Read files directly. If the path is read-only (e.g. an uploads mount), copy the slice you need into your working directory before doing anything stateful. Do not assume the repo root — ask or detect it (look for `package.json`, `.git/`, a framework config).

**Online repository.** Clone it shallowly into a scratch directory, then read from there:

```bash
git clone --depth 1 <repo-url> ./_repo
# specific branch:
git clone --depth 1 --branch <branch> <repo-url> ./_repo
```

- If the user gave a URL to a **specific file or folder** (e.g. a GitHub `/blob/` or `/tree/` link), you only need that slice plus its imports — fetch the raw file(s) rather than cloning the whole repo when that's cheaper.
- **Private repos** need the user's credentials. If a clone fails on auth, stop and ask the user to either make it accessible, provide a token, or point you at a local checkout. Never guess or hardcode credentials.
- **Monorepos**: identify which package/app the user means (`apps/*`, `packages/*`). Don't recreate the whole monorepo — scope to the target.

Keep the cloned repo and your MagicPath working directory (`--dir`) **separate**. The repo is read-only input; the canvas working directory is where you author the recreation.

## Phase 1 — Map the project (read the design foundation first)

Before touching the target component, understand the project's styling system. **Read the global design layer first** — this is what makes the recreation faithful instead of approximate.

1. **Detect the stack.** Read `package.json` dependencies. Note the framework (React, Next.js, Vite, Vue, Svelte, SvelteKit, Angular, Astro, plain HTML, SwiftUI, etc.) and the styling approach (Tailwind, CSS Modules, styled-components, Emotion, vanilla-extract, Sass/SCSS, plain CSS, CSS-in-JS).
2. **Read the global CSS.** Find and read the global stylesheet(s): `global.css`, `globals.css`, `index.css`, `app.css`, `styles/*.css`, or the equivalent. This is where resets, base typography, and CSS custom properties live.
3. **Read the design tokens.** Capture the actual values, not just names:
   - `tailwind.config.{js,ts}` `theme`/`extend` (colors, spacing, radii, shadows, fonts, breakpoints).
   - CSS variables / `:root` blocks and any `.dark` overrides.
   - Dedicated token files (`tokens.*`, `theme.*`, design-system exports).
4. **Read the fonts.** Note how fonts load — `next/font`, `@font-face`, a Google Fonts `<link>`, or a font package — and which families map to body vs. headings.
5. **Note the theming strategy.** Light/dark handling, `ThemeProvider`, `class="dark"` toggling, `prefers-color-scheme`.
6. **Find shared UI primitives.** Look for a `components/ui`, `design-system`, or `primitives` folder. The target component almost certainly composes these (Button, Card, Icon, etc.), and you'll need them to reproduce it.

> **If the user has a MagicPath theme that corresponds to this brand**, prefer reconciling against it: run `list-themes` / `get-theme` and use the theme's CSS variables, fonts, and `prompt` as the styling target. Otherwise, derive the tokens straight from the repo as above.

## Phase 2 — Resolve the target

Pin down exactly what the user asked for and read everything it depends on.

**A single element** ("the sidebar", "my `<Header />`"):

1. Locate the component file (search by name/route).
2. Trace **all** of its dependencies: imported child components, CSS/CSS-module files, icon imports (lucide, heroicons, custom SVGs), and any constants/data it renders.
3. Read the **layout context** it sits in — the parent that gives it width, position, and spacing. A sidebar pulled out of its flex/grid parent will look wrong unless you reproduce the relevant container behavior inside the canvas frame.
4. Resolve styling to concrete values: what do the Tailwind classes / CSS variables actually evaluate to (colors, px, rem)? Faithful recreation means matching the rendered result, not copying class strings blindly.

**A whole project / page** ("render this project"):

1. Identify the route/page entry the user means (a specific page, or the app's primary screen). If "this project" is ambiguous, ask which page or screen — and **stop and wait**.
2. Walk the component tree from that entry to understand structure and scope.
3. Decide scope against **Design Default rule 5** (never stack multiple screens in one frame):
   - One cohesive screen/flow → **one** interactive canvas component with internal state.
   - Several genuinely independent screens → **separate** canvas components, one per screen, each with its own `--dir`.
     Confirm the split with the user before building many frames.

## Phase 3 — Plan the recreation

1. **Choose the frame(s)** and canvas dimensions from the source's intended viewport — e.g. `--width 1440 --height 900` for a desktop app, `--width 390 --height 844` for a mobile screen. The content stays fluid; the dimensions just signal the target form factor.
2. **Map the styling system → Tailwind v4** (the canvas requirement):
   - CSS variables → keep as variables in `src/index.css` (inside the existing `:root`/`.dark`/`@theme inline` blocks) and reference them, e.g. `bg-[var(--background)]`.
   - styled-components / Emotion / CSS-in-JS → equivalent Tailwind utilities.
   - CSS Modules / SCSS → flatten to Tailwind utilities, or append plain CSS to `src/index.css`.
   - Tailwind **v3** config in the source → translate its tokens into v4's `@theme` directive in `src/index.css`. **There is no `tailwind.config.js` on the canvas.**
3. **Plan fonts:** add the required Google Fonts `@import`/`<link>` equivalents or `@font-face` declarations to `src/index.css` and wire the families to the right elements.
4. **Plan assets:** real images go into the working directory's `assets/` folder and get referenced from code/CSS. Do **not** hotlink repo blob URLs and do **not** inline `data:image/...;base64,...`.
5. **Non-React sources** (Vue, Svelte, Angular, plain HTML, SwiftUI, etc.): translate the **markup semantics, visual output, and behavior** into React + Tailwind. Reproduce what it looks like and does — not the original framework's directives/constructs.

## Phase 4 — Build it on the canvas

Use the **create** path of the `code` flow. (Full command details live in `cli-reference.md`.)

1. **Resolve a project.** You need a `projectId`. Use `active-project -o json` if the user has one open, otherwise ask or `create-project`. (See the skill's _Creating a project_ section.)
2. **Start the session before writing files** so the user sees agent presence on the canvas:

   ```bash
   npx -y magicpath-ai code start --project <projectId> --dir ./mp-build --name "Sidebar" --width <px> --height <px> -o json
   ```

3. **Fill in the scaffold faithfully.** Implement the recreation in `src/components/generated/<Name>.tsx`, splitting sub-components (nav item, avatar, etc.) into sibling files under `src/components/generated/`. Edit `src/index.css` for tokens/fonts/custom CSS. **Do not rewrite `src/App.tsx`** — it's pre-wired; only touch it to change the `theme` value. Only these surfaces are editable: `src/App.tsx`, `src/index.css`, `src/components/generated/**`, and `assets/**`.
4. **Honor the Design Defaults** while reproducing the look:
   - **No device mockups** — never wrap the recreation in a phone/browser/laptop frame even if the source app has one. The canvas _is_ the frame.
   - **Responsive** — replace hardcoded outer widths/heights with fluid sizing; the appearance should stay identical at the target width.
   - **Centered** in the frame.
   - **Single screen** — multi-view flows use internal React state, not stacked frames.
   - **Fully interactive** — reproduce real behavior with real state: a collapsible sidebar collapses, the active nav item is driven by state, hovers/focus/active/disabled states are styled, dropdowns and toggles work. A static screenshot of an interactive surface is not done.
5. **Match the visual details precisely:** colors, spacing, border radii, shadows, typography (family/size/weight/line-height/letter-spacing), and transitions. Pull the concrete values you resolved in Phase 1–2.
6. **Mock the data realistically.** The canvas component has no backend — replace server/data-fetching with representative local mock data and local state so the component is self-contained and looks populated, not empty.
7. **Submit and fix:**

   ```bash
   npx -y magicpath-ai code submit --dir ./mp-build --width <px> --height <px> --wait -o json
   ```

   If the job fails, read the returned diagnostics, fix only the allowed files, and re-submit. Don't start a new component to work around a build failure.

## Phase 5 — Verify fidelity

- Open the result (`view <generatedName>`) and compare it against the source app side by side.
- Check that tokens resolved (no stray defaults), fonts loaded, dark mode matches if relevant, and interactions behave like the original.
- Confirm it stays centered and intact at the target width and degrades sensibly when the frame is resized.

---

## Fidelity principles

| Source repo                               | What to produce on the canvas                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| Vue/Svelte/Angular/HTML/SwiftUI markup    | Equivalent React + Tailwind v4 that renders the same UI and behavior             |
| `tailwind.config.js` tokens (v3)          | Same tokens expressed via `@theme` in `src/index.css` (no config file on canvas) |
| CSS Modules / SCSS / styled-components    | Tailwind utilities, with leftovers appended to `src/index.css`                   |
| Fixed-width app shell (`w-[1440px]`)      | Same look, fluid sizing — appearance unchanged, but not pixel-locked             |
| Component pulled out of its layout parent | Reproduce the parent's relevant sizing/positioning inside the frame              |
| Server components / API-driven lists      | Presentational shell + realistic local mock data + local state                   |
| App-context / provider dependencies       | Stub locally so the component is self-contained                                  |
| Real images / SVGs                        | Copy into `assets/` and reference; never base64-inline or hotlink repo blobs     |
| Device frame in the source design         | Drop it — the canvas is the frame (Design Default rule 1)                        |

**The golden rule:** read the global CSS and the full component (with its dependencies) first, reproduce the visual output and behavior exactly, and express it through the canvas's React + Tailwind v4 conventions and Design Defaults.

## Boundaries — what NOT to do

- **Don't use `add`.** That installs registry components into an app; it's the opposite direction.
- **Don't use `inspect` or `code context`.** Those read MagicPath-side source. Here you're reading the **user's repo** and creating a **new** canvas component via `code start` → `code submit`.
- **Don't edit forbidden files** in the working directory: no `package.json`, `vite.config.*`, `src/main.tsx`, lockfiles, or arbitrary repo files — only `src/App.tsx`, `src/index.css`, `src/components/generated/**`, and `assets/**`.
- **Don't dump the whole repo onto the canvas.** Scope to what the user asked for; confirm the screen split before creating multiple frames.
- **Don't invent credentials** for private repos — ask.
- **Don't pixel-lock or add device chrome** even when the source does.

## Quick recipes

**"Bring the sidebar of my app into MagicPath"**

1. Get the code (Phase 0). 2. Read global CSS + tokens + fonts (Phase 1). 3. Open the `Sidebar` component, follow its imports (child items, icons, styles) and read its layout parent for width/position (Phase 2). 4. `code start --project <id> --dir ./mp-build --name "Sidebar" --width <px> --height <px>`. 5. Recreate it faithfully in `src/components/generated/Sidebar.tsx` — real collapse/active-item state, matched colors/spacing/typography, fluid + centered, no device frame. 6. `code submit --wait`. 7. Verify against the app.

**"Render this project / this page in MagicPath"**

1. Get the code (Phase 0). 2. Read the design foundation (Phase 1). 3. Identify the page entry; if ambiguous, ask which screen and **stop**. Walk the tree and decide one interactive frame vs. multiple frames (Phase 2 / Design Default rule 5). 4. For each frame: `code start` with viewport-appropriate dimensions, recreate faithfully with internal navigation state for multi-view flows, mock data realistically. 5. `code submit --wait` each. 6. Verify each against the source.
